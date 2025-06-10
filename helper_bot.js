// helper_bot.js - FINAL UNIFIED VERSION v24 - Performance-Based Darts

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import axios from 'axios';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import cjsPQueue from 'p-queue';

// --- Configuration ---
const HELPER_BOT_TOKEN = process.env.HELPER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MY_BOT_ID = process.env.HELPER_BOT_ID || 'HelperBot_1';
const GAME_LOOP_INTERVAL = 3000;
const PLAYER_ACTION_TIMEOUT = 45000; // 45-second timeout for a player's turn

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const PQueue = cjsPQueue.default ?? cjsPQueue;

// --- Price Fetching & Formatting Dependencies ---
const SOL_DECIMALS = 9;
const solPriceCache = new Map();
const SOL_PRICE_CACHE_KEY = 'sol_usd_price_cache';
const SOL_USD_PRICE_CACHE_TTL_MS = 60 * 60 * 1000;

// --- In-Memory State ---
const activeTurnTimeouts = new Map();

// --- Game Constants ---
// Kingpin's Challenge (PvB Bowling) Constants
const NEW_BOWLING_FRAMES = 5;
const NEW_BOWLING_PINS_PER_ROLL = { 5: 8, 4: 7, 3: 5, 2: 3 };
const NEW_BOWLING_MULTIPLIERS = { STRIKE: 1.75, SPARE: 1.40, OPEN: 0.85 };

// NEW: Performance-Based Darts 501 Challenge (PvB) Constants
const DARTS_PERF_START_SCORE = 501;
const DARTS_PERF_VISIT_LIMIT = 8;
const DARTS_PERF_THROWS_PER_VISIT = 2;
const DARTS_PERF_POINTS_PER_ROLL = { 6: 60, 5: 50, 4: 40, 3: 20, 2: 7, 1: 1 };
const DARTS_PERF_PAR_SCORE_PER_VISIT = 75; // The "Pro" pace to beat
const DARTS_PERF_MULTIPLIER_GAIN = 0.15;  // Multiplier gain per 10 points ahead of par
const DARTS_PERF_MULTIPLIER_LOSS = 0.10; // Multiplier loss per 10 points behind par
const DARTS_PERF_JACKPOT_MULTIPLIER = 10.00;

// Round-Based Basketball (PvB) Game Constants
const ROUND_BASED_HOOPS_ROUNDS = 5;
const ROUND_BASED_HOOPS_SHOTS_PER_ROUND = 2;
const ROUND_BASED_HOOPS_EFFECTS = { 6: { multiplier_effect: 1.8 }, 5: { multiplier_effect: 1.3 }, 4: { multiplier_effect: 1.1 }, 3: { multiplier_effect: 1.0 }, 2: { multiplier_effect: 0.9 }, 1: { multiplier_effect: 0.0 }};

// PvP & Legacy Constants
const PVP_BOWLING_FRAMES = 3;
const PVP_BASKETBALL_SHOTS = 5;
const PVP_DARTS_THROWS = 3;


// --- Database & Bot Setup ---
if (!HELPER_BOT_TOKEN || !DATABASE_URL) {
    console.error("❌ CRITICAL: HELPER_BOT_TOKEN or DATABASE_URL is missing. Helper bot cannot start.");
    process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new TelegramBot(HELPER_BOT_TOKEN, { polling: { params: { allowed_updates: ["message", "callback_query"] } } });
bot.on('polling_error', (error) => console.error(`[Helper] Polling Error: ${error.code} - ${error.message}`));
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 3500, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));

// --- Round-Based Hoops (PvB Basketball) Game Logic ---
async function runRoundBasedHoops(session) {
    const logPrefix = `[RunRoundBasedHoops SID:${session.session_id}]`;
    console.log(`${logPrefix} Starting Round-Based Hoops logic.`);
    let client = null;
    try {
        client = await pool.connect();
        const gameState = session.game_state_json || {};
        gameState.currentRound = 1;
        gameState.shotsTakenInRound = 0;
        gameState.rolls = [];
        gameState.currentMultiplier = 1.0;
        gameState.status = 'awaiting_shots';
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updateRoundBasedHoopsMessage(session.session_id);
    } catch (e) { console.error(`${logPrefix} Error starting game: ${e.message}`); await finalizeGame(session, 'error'); } finally { if (client) client.release(); }
}
async function updateRoundBasedHoopsMessage(sessionId) {
    const logPrefix = `[UpdateRoundBasedHoopsMsg SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) return;
        const session = res.rows[0];
        const gameState = session.game_state_json;
        if (activeTurnTimeouts.has(sessionId)) { clearTimeout(activeTurnTimeouts.get(sessionId)); activeTurnTimeouts.delete(sessionId); }
        if (gameState.lastMessageId) { await bot.deleteMessage(session.chat_id, gameState.lastMessageId).catch(() => {}); }
        const betDisplayUSD = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
        const gameName = "Round-Based Hoops";
        const currentPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
        const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');
        let titleHTML = `🏀 <b>${escape(gameName)}</b> | ${escape(gameState.p1Name)}\n`;
        let bodyHTML = `Wager: <b>${escape(betDisplayUSD)}</b>\n\n`;
        bodyHTML += `<b>Round: ${gameState.currentRound}/${ROUND_BASED_HOOPS_ROUNDS}</b> | Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b>\n`;
        bodyHTML += `Current Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;
        const keyboardRows = [];
        let promptHTML = "";
        if (gameState.status === 'awaiting_shots') {
            const shotsRemaining = ROUND_BASED_HOOPS_SHOTS_PER_ROUND - gameState.shotsTakenInRound;
            promptHTML = `Please send <b>${shotsRemaining}</b> 🏀 emoji(s) to play Round ${gameState.currentRound}.`;
        } else if (gameState.status === 'awaiting_cashout_decision') {
            promptHTML = `<b>Round ${gameState.currentRound - 1} Complete!</b>\nWhat's your next move?`;
            keyboardRows.push(
                [{ text: `💰 Cash Out (${escape(currentPayoutDisplay)})`, callback_data: `interactive_cashout:${sessionId}` }],
                [{ text: `▶️ Start Next Round`, callback_data: `interactive_continue:${sessionId}` }]
            );
        }
        promptHTML += `\n<i>(Timeout: ${PLAYER_ACTION_TIMEOUT / 1000} seconds)</i>`;
        const fullMessage = `${titleHTML}${bodyHTML}<i>${promptHTML}</i>`;
        const sentMsg = await queuedSendMessage(session.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
        if (sentMsg) {
            gameState.lastMessageId = sentMsg.message_id;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            const timeoutId = setTimeout(() => handleGameTimeout(sessionId), PLAYER_ACTION_TIMEOUT);
            activeTurnTimeouts.set(sessionId, timeoutId);
        }
    } catch (e) { console.error(`${logPrefix} Error: ${e.message}`); } finally { if (client) client.release(); }
}
async function handleRoundBasedHoopsRoll(session, rollValue) {
    const gameState = session.game_state_json;
    if (gameState.status !== 'awaiting_shots') return;
    const effect = ROUND_BASED_HOOPS_EFFECTS[rollValue];
    if (!effect) { console.error(`[HandleRoundBasedHoopsRoll SID:${session.session_id}] Invalid roll value: ${rollValue}`); return; }
    if (effect.multiplier_effect === 0.0) {
        gameState.rolls.push(rollValue);
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await finalizeGame(session, 'completed_loss');
        return;
    }
    gameState.rolls.push(rollValue);
    gameState.shotsTakenInRound++;
    gameState.currentMultiplier *= effect.multiplier_effect;
    if (gameState.shotsTakenInRound >= ROUND_BASED_HOOPS_SHOTS_PER_ROUND) {
        gameState.currentRound++;
        if (gameState.currentRound > ROUND_BASED_HOOPS_ROUNDS) {
            await finalizeGame(session, 'completed_cashout');
        } else {
            gameState.status = 'awaiting_cashout_decision';
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await updateRoundBasedHoopsMessage(session.session_id);
        }
    } else {
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    }
}

// --- Kingpin's Challenge (PvB Bowling) Game Logic ---
async function runKingpinsChallenge(session) {
    const logPrefix = `[RunKingpins SID:${session.session_id}]`;
    console.log(`${logPrefix} Starting Kingpin's Challenge logic.`);
    let client = null;
    try {
        client = await pool.connect();
        const gameState = session.game_state_json || {};
        gameState.currentFrame = 1;
        gameState.shotsInCurrentFrame = 0;
        gameState.pinsFromFirstShot = 0;
        gameState.frameHistory = [];
        gameState.currentMultiplier = 1.0;
        gameState.status = 'awaiting_first_shot';
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updateKingpinsChallengeMessage(session.session_id);
    } catch (e) { console.error(`${logPrefix} Error starting game: ${e.message}`); await finalizeGame(session, 'error'); } finally { if (client) client.release(); }
}
async function updateKingpinsChallengeMessage(sessionId) {
    const logPrefix = `[UpdateKingpinsMsg SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) return;
        const session = res.rows[0];
        const gameState = session.game_state_json;
        if (activeTurnTimeouts.has(sessionId)) { clearTimeout(activeTurnTimeouts.get(sessionId)); activeTurnTimeouts.delete(sessionId); }
        if (gameState.lastMessageId) { await bot.deleteMessage(session.chat_id, gameState.lastMessageId).catch(() => {}); }
        const betDisplayUSD = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
        const currentPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
        const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');
        let titleHTML = `🎳 <b>Kingpin's Challenge</b> 🎳\nPlayer: <b>${escape(gameState.p1Name)}</b> | Wager: <b>${escape(betDisplayUSD)}</b>\n\n`;
        let bodyHTML = "";
        if (gameState.frameHistory.length > 0) {
            const lastFrame = gameState.frameHistory[gameState.frameHistory.length - 1];
            bodyHTML += `Frame ${lastFrame.frame} Result: <b>${escape(lastFrame.result)}</b> (Shots: ${lastFrame.rolls.join(', ')})\n`;
        }
        bodyHTML += `Total Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b>\nCurrent Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;
        const keyboardRows = [];
        let promptHTML = "";
        if (gameState.status === 'awaiting_cashout_decision') {
            promptHTML = `<i>Frame ${gameState.currentFrame - 1} complete! Risk it or cash out?</i>`;
            keyboardRows.push(
                [{ text: `💰 Cash Out (${escape(currentPayoutDisplay)})`, callback_data: `interactive_cashout:${sessionId}` }],
                [{ text: `▶️ Bowl Next Frame`, callback_data: `interactive_continue:${sessionId}` }]
            );
        } else {
            promptHTML = `<i>Frame ${gameState.currentFrame}/${NEW_BOWLING_FRAMES}. Send a 🎳 to bowl your first shot!</i>`;
        }
        const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
        const sentMsg = await queuedSendMessage(session.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
        if (sentMsg) {
            gameState.lastMessageId = sentMsg.message_id;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            const timeoutId = setTimeout(() => handleGameTimeout(sessionId), PLAYER_ACTION_TIMEOUT);
            activeTurnTimeouts.set(sessionId, timeoutId);
        }
    } catch (e) { console.error(`${logPrefix} Error: ${e.message}`); } finally { if (client) client.release(); }
}
async function handleKingpinsChallengeRoll(session, rollValue) {
    const gameState = session.game_state_json;
    if (rollValue === 1) { await finalizeGame(session, 'completed_loss'); return; }
    if (gameState.shotsInCurrentFrame === 0) {
        if (rollValue === 6) {
            gameState.currentMultiplier *= NEW_BOWLING_MULTIPLIERS.STRIKE;
            gameState.frameHistory.push({ frame: gameState.currentFrame, result: 'Strike 💎', rolls: [6], frameMultiplier: NEW_BOWLING_MULTIPLIERS.STRIKE });
            if (gameState.currentFrame >= NEW_BOWLING_FRAMES) { await finalizeGame(session, 'completed_cashout'); } else {
                gameState.currentFrame++;
                gameState.status = 'awaiting_cashout_decision';
                await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
                await updateKingpinsChallengeMessage(session.session_id);
            }
        } else {
            gameState.shotsInCurrentFrame = 1;
            gameState.pinsFromFirstShot = NEW_BOWLING_PINS_PER_ROLL[rollValue] || 0;
            gameState.firstRollValue = rollValue;
            gameState.status = 'awaiting_second_shot';
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await queuedSendMessage(session.chat_id, `Shot 1: ${gameState.pinsFromFirstShot} pins! Send another 🎳 to complete the frame.`, { disable_notification: true }).then(msg => {
                setTimeout(() => bot.deleteMessage(session.chat_id, msg.message_id).catch(() => {}), 4000);
            });
        }
    } else if (gameState.shotsInCurrentFrame === 1) {
        const pinsFromSecondShot = NEW_BOWLING_PINS_PER_ROLL[rollValue] || 0;
        const totalPins = gameState.pinsFromFirstShot + pinsFromSecondShot;
        const rolls = [gameState.firstRollValue, rollValue];
        let result, frameMultiplier;
        if (totalPins >= 10) { result = 'Spare ⭐'; frameMultiplier = NEW_BOWLING_MULTIPLIERS.SPARE; } else { result = 'Open Frame'; frameMultiplier = NEW_BOWLING_MULTIPLIERS.OPEN; }
        gameState.currentMultiplier *= frameMultiplier;
        gameState.frameHistory.push({ frame: gameState.currentFrame, result, rolls, frameMultiplier });
        gameState.shotsInCurrentFrame = 0;
        gameState.pinsFromFirstShot = 0;
        if (gameState.currentFrame >= NEW_BOWLING_FRAMES) { await finalizeGame(session, 'completed_cashout'); } else {
            gameState.currentFrame++;
            gameState.status = 'awaiting_cashout_decision';
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await updateKingpinsChallengeMessage(session.session_id);
        }
    }
}

// --- Performance-Based Darts 501 Challenge (PvB) Game Logic ---
async function runPerformanceDarts(session) {
    const logPrefix = `[RunPerfDarts SID:${session.session_id}]`;
    console.log(`${logPrefix} Starting Performance Darts 501 Challenge logic.`);
    let client = null;
    try {
        client = await pool.connect();
        const gameState = session.game_state_json || {};
        gameState.remainingScore = DARTS_PERF_START_SCORE;
        gameState.currentVisit = 1;
        gameState.throwsInVisit = 0;
        gameState.visitHistory = [];
        gameState.currentMultiplier = 1.0;
        gameState.status = 'awaiting_throw';
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updatePerformanceDartsMessage(session.session_id);
    } catch (e) { console.error(`${logPrefix} Error starting game: ${e.message}`); await finalizeGame(session, 'error'); } finally { if (client) client.release(); }
}
async function updatePerformanceDartsMessage(sessionId, lastVisitResult = null) {
    const logPrefix = `[UpdatePerfDartsMsg SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) return;
        const session = res.rows[0];
        const gameState = session.game_state_json;
        if (activeTurnTimeouts.has(sessionId)) { clearTimeout(activeTurnTimeouts.get(sessionId)); activeTurnTimeouts.delete(sessionId); }
        if (gameState.lastMessageId) { await bot.deleteMessage(session.chat_id, gameState.lastMessageId).catch(() => {}); }

        // --- DYNAMIC MULTIPLIER CALCULATION ---
        const parScoreForThisStage = DARTS_PERF_START_SCORE - ((gameState.currentVisit - 1) * DARTS_PERF_PAR_SCORE_PER_VISIT);
        const scoreDifference = parScoreForThisStage - gameState.remainingScore;
        const tenPointIntervals = Math.round(scoreDifference / 10);
        let multiplierBonus = 0;
        if (tenPointIntervals > 0) { multiplierBonus = tenPointIntervals * DARTS_PERF_MULTIPLIER_GAIN; }
        else { multiplierBonus = tenPointIntervals * DARTS_PERF_MULTIPLIER_LOSS; } // This will be negative if behind par
        gameState.currentMultiplier = 1.0 + multiplierBonus;
        
        const betDisplayUSD = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
        const currentPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
        const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');

        let titleHTML = `🎯 <b>Darts 501 Challenge</b> 🎯\nPlayer: <b>${escape(gameState.p1Name)}</b> | Wager: <b>${escape(betDisplayUSD)}</b>\n`;
        titleHTML += `<b>Visits Remaining: ${DARTS_PERF_VISIT_LIMIT - gameState.currentVisit + 1} / ${DARTS_PERF_VISIT_LIMIT}</b>\n\n`;
        let bodyHTML = ``;
        if (lastVisitResult) {
            if (lastVisitResult.isBust) { bodyHTML += `<i>Last Visit: BUST! Throws <b>[${lastVisitResult.rolls.join(', ')}]</b> exceeded score. No points deducted.</i>\n`; }
            else { bodyHTML += `<i>Last Visit: Throws <b>[${lastVisitResult.rolls.join(', ')}]</b> scored <b>${lastVisitResult.score}</b> points!</i>\n`; }
        }
        bodyHTML += `Score Remaining: <b>${gameState.remainingScore}</b>\n`;
        bodyHTML += `Multiplier (vs Par): <b>x${gameState.currentMultiplier.toFixed(2)}</b> | Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;

        const keyboardRows = [];
        let promptHTML = "";

        if (gameState.status === 'awaiting_cashout_decision') {
            promptHTML = `<i>Visit ${gameState.currentVisit - 1} complete. Your performance has been evaluated. What's the play?</i>`;
            keyboardRows.push(
                [{ text: `💰 Cash Out (${escape(currentPayoutDisplay)})`, callback_data: `interactive_cashout:${sessionId}` }],
                [{ text: `▶️ Throw Next Darts`, callback_data: `interactive_continue:${sessionId}` }]
            );
        } else {
            const throwsNeeded = DARTS_PERF_THROWS_PER_VISIT - gameState.throwsInVisit;
            promptHTML = `<i>Visit ${gameState.currentVisit}/${DARTS_PERF_VISIT_LIMIT}. Send <b>${throwsNeeded}</b> 🎯 to throw.</i>`;
        }
        
        const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
        const sentMsg = await queuedSendMessage(session.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
        if (sentMsg) {
            gameState.lastMessageId = sentMsg.message_id;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            const timeoutId = setTimeout(() => handleGameTimeout(sessionId), PLAYER_ACTION_TIMEOUT);
            activeTurnTimeouts.set(sessionId, timeoutId);
        }
    } catch (e) { console.error(`${logPrefix} Error: ${e.message}`); } finally { if (client) client.release(); }
}
async function handlePerformanceDartsThrow(session, rollValue) {
    const gameState = session.game_state_json;
    if (gameState.status !== 'awaiting_throw') return;

    gameState.throwsInVisit++;
    if (!gameState.currentVisitThrows) gameState.currentVisitThrows = [];
    gameState.currentVisitThrows.push(rollValue);

    if (gameState.throwsInVisit >= DARTS_PERF_THROWS_PER_VISIT) {
        const scoreThisVisit = gameState.currentVisitThrows.reduce((sum, roll) => sum + (DARTS_PERF_POINTS_PER_ROLL[roll] || 0), 0);
        let lastVisitResult = { rolls: gameState.currentVisitThrows, score: scoreThisVisit, isBust: false };
        const scoreAfterThrow = gameState.remainingScore - scoreThisVisit;

        if (scoreAfterThrow === 0) { // WIN
            gameState.currentMultiplier = DARTS_PERF_JACKPOT_MULTIPLIER;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await finalizeGame(session, 'completed_cashout');
            return;
        } else if (scoreAfterThrow < 0 || scoreAfterThrow === 1) { // BUST
            lastVisitResult.isBust = true;
        } else { // Valid score
            gameState.remainingScore = scoreAfterThrow;
        }

        gameState.visitHistory.push(lastVisitResult);
        gameState.currentVisit++;
        gameState.throwsInVisit = 0;
        gameState.currentVisitThrows = [];

        if (gameState.currentVisit > DARTS_PERF_VISIT_LIMIT) { await finalizeGame(session, 'completed_loss'); return; }

        gameState.status = gameState.currentVisit > 1 ? 'awaiting_cashout_decision' : 'awaiting_throw';
        
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updatePerformanceDartsMessage(session.session_id, lastVisitResult);
    } else {
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    }
}

// --- GAME ENGINE & STATE MACHINE ---
async function handleGameStart(session) {
    const logPrefix = `[HandleStart SID:${session.session_id}]`;
    console.log(`${logPrefix} Initializing game: ${session.game_type}`);
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const updateRes = await client.query("UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2 AND status = 'pending_pickup' RETURNING *", [MY_BOT_ID, session.session_id]);
        if (updateRes.rowCount === 0) { await client.query('ROLLBACK'); console.log(`${logPrefix} Game already picked up. Aborting.`); return; }
        
        const liveSession = updateRes.rows[0];
        const gameState = liveSession.game_state_json || {};
        const gameType = liveSession.game_type;
        const isNewPvPDuel = gameType.includes('_pvp');
        
        if (['basketball', 'bowling', 'darts'].includes(gameType) && !isNewPvPDuel) {
            // Initialization is handled within their own `run...` functions
        } else if (isNewPvPDuel) {
            gameState.p1Rolls = []; gameState.p1Score = 0;
            gameState.p2Rolls = []; gameState.p2Score = 0;
        }
        
        gameState.p1Name = gameState.initiatorName || "Player 1";
        gameState.currentPlayerTurn = String(gameState.initiatorId || liveSession.user_id);
        if (gameState.gameMode === 'pvp') gameState.p2Name = gameState.opponentName || "Player 2";
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await client.query('COMMIT');

        if (gameType === 'basketball') { await runRoundBasedHoops(liveSession); } 
        else if (gameType === 'bowling' && !isNewPvPDuel) { await runKingpinsChallenge(liveSession); }
        else if (gameType === 'darts' && !isNewPvPDuel) { await runPerformanceDarts(liveSession); }
        else if (isNewPvPDuel) { await advancePvPGameState(liveSession.session_id); }
        else { console.error(`${logPrefix} Unknown game type to start: ${gameType}`); await finalizeGame(liveSession, 'error'); }
    } catch (e) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} Error initializing game: ${e.message}`); } finally { if (client) client.release(); }
}
async function advancePvPGameState(sessionId) {
    const logPrefix = `[AdvancePvP SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;
        const session = res.rows[0];
        const gameState = session.game_state_json || {};
        const gameType = session.game_type;
        const shotsPerPlayer = getShotsPerPlayer(gameType);
        const p1_done = (gameState.p1Rolls || []).length >= shotsPerPlayer;
        const p2_done = (gameState.p2Rolls || []).length >= shotsPerPlayer;
        if (p1_done && p2_done) { await finalizeGame(session, 'pvp_resolve'); return; }
        gameState.currentPlayerTurn = !p1_done ? String(gameState.initiatorId) : String(gameState.opponentId);
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        await promptPvPAction(session, gameState);
    } catch (e) { console.error(`${logPrefix} Error: ${e.message}`); await finalizeGame({session_id: sessionId}, 'error'); } finally { if (client) client.release(); }
}
async function promptPvPAction(session, gameState) {
    const { chat_id, game_type } = session;
    const { p1Name, p2Name, p1Rolls, p2Rolls, currentPlayerTurn, initiatorId } = gameState;
    const gameName = getCleanGameNameHelper(game_type);
    const emoji = getGameEmoji(game_type);
    const shotsPerPlayer = getShotsPerPlayer(game_type);
    const p1Score = calculateFinalScore(game_type, p1Rolls);
    const p2Score = calculateFinalScore(game_type, p2Rolls);
    const nextPlayerName = (String(currentPlayerTurn) === String(initiatorId)) ? p1Name : p2Name;
    const nextPlayerRolls = (String(currentPlayerTurn) === String(initiatorId)) ? (p1Rolls || []) : (p2Rolls || []);
    let scoreBoardHTML = `<b>${p1Name}:</b> ${formatRollsHelper(p1Rolls || [])} ➠ Score: <b>${p1Score}</b>\n` + `<b>${p2Name}:</b> ${formatRollsHelper(p2Rolls || [])} ➠ Score: <b>${p2Score}</b>`;
    let messageHTML = `⚔️ <b>${gameName}</b> ⚔️\n\n${scoreBoardHTML}\n\n` + `It's your turn, <b>${nextPlayerName}</b>! Send a ${emoji} to roll (Roll ${nextPlayerRolls.length + 1} of ${shotsPerPlayer}).`;
    await queuedSendMessage(chat_id, messageHTML, { parse_mode: 'HTML' });
}
async function handleRollSubmitted(session, lastRoll) {
    const logPrefix = `[HandleRoll SID:${session.session_id}]`;
    try {
        if (session.status !== 'in_progress') { console.warn(`${logPrefix} Roll received for non-active game. Ignoring.`); return; }
        const gameType = session.game_type;
        if (gameType === 'basketball') { await handleRoundBasedHoopsRoll(session, lastRoll); }
        else if (gameType === 'bowling' && !gameType.includes('_pvp')) { await handleKingpinsChallengeRoll(session, lastRoll); }
        else if (gameType === 'darts' && !gameType.includes('_pvp')) { await handlePerformanceDartsThrow(session, lastRoll); }
        else if (gameType.includes('_pvp')) {
            const gameState = session.game_state_json || {};
            if (activeTurnTimeouts.has(session.session_id)) { clearTimeout(activeTurnTimeouts.get(session.session_id)); activeTurnTimeouts.delete(session.session_id); }
            const playerKey = (String(gameState.initiatorId) === gameState.currentPlayerTurn) ? 'p1' : 'p2';
            if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
            gameState[`${playerKey}Rolls`].push(lastRoll);
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await advancePvPGameState(session.session_id);
        }
    } catch (e) { console.error(`${logPrefix} Error handling submitted roll: ${e.message}`); }
}
async function finalizeGame(session, finalStatus) {
    const sessionId = session.session_id;
    const logPrefix = `[FinalizeGame SID:${sessionId}]`;
    if (activeTurnTimeouts.has(sessionId)) { clearTimeout(activeTurnTimeouts.get(sessionId)); activeTurnTimeouts.delete(sessionId); }
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const liveSessionRes = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
        if(liveSessionRes.rowCount === 0) { await client.query('ROLLBACK'); return; }
        const liveSession = liveSessionRes.rows[0];
        const gameState = liveSession.game_state_json;
        let dbStatus = finalStatus;
        let finalPayout = 0n;
        if (finalStatus === 'completed_cashout') {
            dbStatus = 'completed_cashout';
            const multiplier = gameState.currentMultiplier || 0;
            finalPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(multiplier * 100))) / 100n;
        } else if (['completed_loss', 'completed_timeout', 'error'].includes(finalStatus)) {
            dbStatus = finalStatus === 'completed_timeout' ? 'completed_timeout' : 'completed_loss';
            finalPayout = 0n;
        }
        if (finalStatus === 'pvp_resolve') {
            const p1Score = calculateFinalScore(liveSession.game_type, gameState.p1Rolls);
            const p2Score = calculateFinalScore(liveSession.game_type, gameState.p2Rolls);
            gameState.p1Score = p1Score; gameState.p2Score = p2Score;
            if (p1Score > p2Score) dbStatus = 'completed_p1_win';
            else if (p2Score > p1Score) dbStatus = 'completed_p2_win';
            else dbStatus = 'completed_push';
        }
        gameState.finalStatus = dbStatus;
        await client.query("UPDATE interactive_game_sessions SET status = $1, final_payout_lamports = $2, game_state_json = $3 WHERE session_id = $4", [dbStatus, finalPayout.toString(), JSON.stringify(gameState), sessionId]);
        await client.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: sessionId })}'`);
        await client.query('COMMIT');
        if(gameState.lastMessageId) { await bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(()=>{}); }
    } catch (e) { if(client) await client.query('ROLLBACK'); console.error(`${logPrefix} Error finalizing game: ${e.message}`); } finally { if(client) client.release(); }
}

// --- EVENT HANDLERS & MAIN LOOP ---
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const fromId = String(callbackQuery.from.id);
    if (!data) return;
    const [action, sessionId] = data.split(':');

    if (action === 'interactive_cashout') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Cashing out..." }).catch(() => {});
        const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount > 0 && res.rows[0].status === 'in_progress') {
            const session = res.rows[0];
            if(String(session.user_id) !== fromId) return;
            await finalizeGame(session, 'completed_cashout');
        }
    } else if (action === 'interactive_continue') {
        await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
        const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount > 0 && res.rows[0].status === 'in_progress') {
            const session = res.rows[0];
            if(String(session.user_id) !== fromId) return;
            const gameState = session.game_state_json;
            const gameType = session.game_type;

            if (gameType === 'bowling' && gameState.status === 'awaiting_cashout_decision') {
                gameState.status = 'awaiting_first_shot';
                await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
                await updateKingpinsChallengeMessage(session.session_id);
            } else if (gameType === 'basketball' && gameState.status === 'awaiting_cashout_decision') {
                gameState.shotsTakenInRound = 0;
                gameState.status = 'awaiting_shots';
                await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
                await updateRoundBasedHoopsMessage(session.session_id);
            } else if (gameType === 'darts' && gameState.status === 'awaiting_cashout_decision') {
                gameState.status = 'awaiting_throw';
                await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
                await updatePerformanceDartsMessage(session.session_id);
            }
        }
    }
});
async function handleGameTimeout(sessionId) {
    console.log(`[GameTimeout SID:${sessionId}] Player turn timed out.`);
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
    if (res.rowCount > 0 && res.rows[0].status === 'in_progress') { await finalizeGame(res.rows[0], 'completed_timeout'); }
}
async function handleNotification(msg) {
    try {
        const payload = JSON.parse(msg.payload);
        const session = payload.session || payload;
        if (!session) return;
        const sessionId = session.session_id || (typeof payload === 'number' ? payload : null);
        const mainBotGameId = session.main_bot_game_id;
        if (msg.channel === 'game_session_pickup') {
            const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE main_bot_game_id = $1", [mainBotGameId]);
            if (res.rows.length > 0) await handleGameStart(res.rows[0]);
        } else if (msg.channel === 'interactive_roll_submitted') {
            const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
            if (res.rows.length > 0) {
                const lastRoll = res.rows[0].game_state_json?.lastRoll;
                if (typeof lastRoll === 'number') { await handleRollSubmitted(res.rows[0], lastRoll); }
                else { console.error(`[Helper] Roll notification for SID:${sessionId}, but lastRoll not found.`); }
            }
        }
    } catch (e) { console.error('[Helper] Error processing notification payload:', e); }
}
async function setupNotificationListeners() {
    console.log("⚙️ [Helper] Setting up notification listeners...");
    const listeningClient = await pool.connect();
    listeningClient.on('error', (err) => { console.error('[Helper] Listener client error:', err); setTimeout(setupNotificationListeners, 5000); });
    listeningClient.on('notification', handleNotification);
    await listeningClient.query('LISTEN game_session_pickup');
    await listeningClient.query('LISTEN interactive_roll_submitted');
    console.log("✅ [Helper] Now listening for 'game_session_pickup' and 'interactive_roll_submitted'.");
}
async function processPendingGames() {
    if (processPendingGames.isRunning) return;
    processPendingGames.isRunning = true;
    let client = null;
    try {
        client = await pool.connect();
        const pendingSessions = await client.query("SELECT * FROM interactive_game_sessions WHERE status = 'pending_pickup' ORDER BY created_at ASC LIMIT 5");
        for (const session of pendingSessions.rows) {
            await client.query(`NOTIFY game_session_pickup, '${JSON.stringify({ session: session })}'`);
        }
    } catch (e) { console.error(`[Helper Fallback Poller] Error: ${e.message}`); } finally { if (client) client.release(); processPendingGames.isRunning = false; }
}
processPendingGames.isRunning = false;

// --- UTILITY FUNCTIONS ---
function escape(text) { if (text === null || typeof text === 'undefined') return ''; return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');}
async function getSolUsdPrice() { const cached = solPriceCache.get(SOL_PRICE_CACHE_KEY); if (cached && (Date.now() - cached.timestamp < SOL_USD_PRICE_CACHE_TTL_MS)) return cached.price; try { const price = await (await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 8000 })).data?.price; solPriceCache.set(SOL_PRICE_CACHE_KEY, { price: parseFloat(price), timestamp: Date.now() }); return parseFloat(price); } catch (e) { try { const price = await (await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 8000 })).data?.solana?.usd; solPriceCache.set(SOL_PRICE_CACHE_KEY, { price: parseFloat(price), timestamp: Date.now() }); return parseFloat(price); } catch (e2) { if (cached) return cached.price; throw new Error("Could not retrieve SOL/USD price."); } }}
function convertLamportsToUSDString(lamports, solUsdPrice, d = 2) { if (typeof solUsdPrice !== 'number' || solUsdPrice <= 0) return 'N/A'; const sol = Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL); return `$${(sol * solUsdPrice).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;}
async function formatBalanceForDisplay(lamports, currency = 'USD') { if (currency === 'USD') { try { const price = await getSolUsdPrice(); return convertLamportsToUSDString(lamports, price); } catch (e) { return 'N/A'; } } return `${(Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL)).toFixed(SOL_DECIMALS)} SOL`;}
function getShotsPerPlayer(gameType) { const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return PVP_BOWLING_FRAMES; if (lt.includes('basketball_clash_pvp')) return PVP_BASKETBALL_SHOTS; if (lt.includes('darts_duel_pvp')) return PVP_DARTS_THROWS; return 1; }
function calculateFinalScore(gameType, rolls) { const safeRolls = rolls || []; if (safeRolls.length === 0) return 0; if (gameType.includes('basketball')) return safeRolls.filter(r => r >= 4).length; return safeRolls.reduce((a, b) => a + b, 0); }
function getCleanGameNameHelper(gameType) { if (!gameType) return "Game"; const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return "Bowling Duel"; if (lt.includes('darts_duel_pvp')) return "Darts Showdown"; if (lt.includes('basketball_clash_pvp')) return "3-Point Clash"; if (lt === 'bowling') return "Kingpin's Challenge"; if (lt === 'darts') return "Darts 501 Challenge"; if (lt === 'basketball') return "Round-Based Hoops"; return "Game"; }
function getGameEmoji(gameType) { if (gameType.includes('bowling')) return '🎳'; if (gameType.includes('darts')) return '🎯'; if (gameType.includes('basketball')) return '🏀'; return '🎲'; }
function formatRollsHelper(rolls) { if (!rolls || rolls.length === 0) return '...'; return rolls.map(r => `<b>${r}</b>`).join(' '); }

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => { console.error("CRITICAL: Could not set up notification listeners.", e); process.exit(1); });
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
