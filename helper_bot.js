// helper_bot.js - FINAL UNIFIED VERSION v25 - Dual Darts Games & Auto-Roll Implemented

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
const rollDice = () => Math.floor(Math.random() * 6) + 1;

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

// Bullseye Blitz (Fast PvB Darts) Constants
const BLITZ_DARTS_ROUNDS = 3;
const BLITZ_DARTS_THROWS_PER_ROUND = 2;
const BLITZ_DARTS_POINTS_PER_ROLL = { 6: 60, 5: 50, 4: 40, 3: 20, 2: 7, 1: 1 };
const BLITZ_DARTS_MULTIPLIERS = [1.5, 3.0, 5.0]; // Multiplier for completing rounds 1, 2, 3
const BLITZ_DARTS_BUST_ROLL_MAX = 2; // If both rolls in a round are this or lower, it's a bust

// Performance-Based Darts 501 Challenge (PvB) Constants
const DARTS_501_START_SCORE = 501;
const DARTS_501_VISIT_LIMIT = 8;
const DARTS_501_THROWS_PER_VISIT = 2;
const DARTS_501_PAR_SCORE_PER_VISIT = 75;
const DARTS_501_MULTIPLIER_GAIN = 0.15;
const DARTS_501_MULTIPLIER_LOSS = 0.10;
const DARTS_501_JACKPOT_MULTIPLIER = 10.00;

// Round-Based Basketball (PvB) Game Constants
const ROUND_BASED_HOOPS_ROUNDS = 5;
const ROUND_BASED_HOOPS_SHOTS_PER_ROUND = 2;
const ROUND_BASED_HOOPS_EFFECTS = { 6: { multiplier_effect: 1.8 }, 5: { multiplier_effect: 1.3 }, 4: { multiplier_effect: 1.1 }, 3: { multiplier_effect: 1.0 }, 2: { multiplier_effect: 0.9 }, 1: { multiplier_effect: 0.0 }};

// PvP Constants
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
// API Failsafe Queue: Process max 1 message every 3.5 seconds to stay under the 20 msg/min/group limit.
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 3500, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args).catch(console.error));
const queuedEditMessage = (...args) => telegramSendQueue.add(() => bot.editMessageText(...args).catch(console.error));


// --- Round-Based Hoops (PvB Basketball) Game Logic ---
async function runRoundBasedHoops(session) {
    const gameState = session.game_state_json || {};
    gameState.currentRound = 1;
    gameState.rolls = [];
    gameState.currentMultiplier = 1.0;
    gameState.status = 'awaiting_decision';
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await updateRoundBasedHoopsMessage(session.session_id);
}
async function updateRoundBasedHoopsMessage(session, lastRoundRolls = null) {
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [session.session_id]);
    if (res.rowCount === 0) return;
    const liveSession = res.rows[0];
    const gameState = liveSession.game_state_json;
    if (gameState.lastMessageId) { await bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(() => {}); }
    
    const betDisplayUSD = await formatBalanceForDisplay(liveSession.bet_amount_lamports, 'USD');
    const currentPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
    const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');
    
    let titleHTML = `🏀 <b>Round-Based Hoops</b> | ${escape(gameState.p1Name)}\n`;
    let bodyHTML = `Wager: <b>${escape(betDisplayUSD)}</b>\n\n`;
    if (lastRoundRolls) { bodyHTML += `<i>Last Round's Shots: ${lastRoundRolls.join(', ')}</i>\n`; }
    bodyHTML += `<b>Round: ${gameState.currentRound}/${ROUND_BASED_HOOPS_ROUNDS}</b> | Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b>\n`;
    bodyHTML += `Current Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;
    
    let promptHTML = `<i>Round ${gameState.currentRound}. Ready to shoot?</i>`;
    const keyboardRows = [[
        { text: `💰 Cash Out (${currentPayoutDisplay})`, callback_data: `interactive_cashout:${liveSession.session_id}` },
        { text: `▶️ Shoot Hoops`, callback_data: `interactive_continue:${liveSession.session_id}` }
    ]];

    if (gameState.currentRound === 1 && !lastRoundRolls) { promptHTML = `<i>Your first round. Let's play!</i>`; keyboardRows[0].shift(); }

    const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
    const sentMsg = await queuedSendMessage(liveSession.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
    if (sentMsg) {
        gameState.lastMessageId = sentMsg.message_id;
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
    }
}
async function handleRoundBasedHoopsContinue(session) {
    const gameState = session.game_state_json;
    const rolls = [rollDice(), rollDice()];
    let roundMultiplier = 1.0;
    for (const roll of rolls) {
        const effect = ROUND_BASED_HOOPS_EFFECTS[roll];
        if (effect.multiplier_effect === 0.0) { await finalizeGame(session, 'completed_loss'); return; }
        roundMultiplier *= effect.multiplier_effect;
    }
    gameState.currentMultiplier *= roundMultiplier;
    gameState.currentRound++;
    if (gameState.currentRound > ROUND_BASED_HOOPS_ROUNDS) { await finalizeGame(session, 'completed_cashout'); }
    else {
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updateRoundBasedHoopsMessage(session, rolls);
    }
}

// --- Kingpin's Challenge (PvB Bowling) Game Logic ---
async function runKingpinsChallenge(session) {
    const gameState = session.game_state_json || {};
    gameState.currentFrame = 1;
    gameState.frameHistory = [];
    gameState.currentMultiplier = 1.0;
    gameState.status = 'awaiting_decision';
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await updateKingpinsChallengeMessage(session);
}
async function updateKingpinsChallengeMessage(session, lastFrameResult = null) {
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [session.session_id]);
    if (res.rowCount === 0) return;
    const liveSession = res.rows[0];
    const gameState = liveSession.game_state_json;
    if (gameState.lastMessageId) { await bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(() => {}); }

    const betDisplayUSD = await formatBalanceForDisplay(liveSession.bet_amount_lamports, 'USD');
    const currentPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
    const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');
    let titleHTML = `🎳 <b>Kingpin's Challenge</b> | ${escape(gameState.p1Name)}\n`;
    let bodyHTML = `Wager: <b>${escape(betDisplayUSD)}</b>\n\n`;
    if (lastFrameResult) { bodyHTML += `<i>Frame ${gameState.currentFrame - 1} Result: <b>${escape(lastFrameResult.result)}</b> (Shots: ${lastFrameResult.rolls.join(', ')})</i>\n`; }
    bodyHTML += `Total Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b> | Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;
    
    let promptHTML = `<i>Frame ${gameState.currentFrame}/${NEW_BOWLING_FRAMES}. Ready to bowl?</i>`;
    const keyboardRows = [[
        { text: `💰 Cash Out (${currentPayoutDisplay})`, callback_data: `interactive_cashout:${liveSession.session_id}` },
        { text: `▶️ Bowl Next Frame`, callback_data: `interactive_continue:${liveSession.session_id}` }
    ]];
    if (gameState.currentFrame === 1 && !lastFrameResult) { promptHTML = `<i>Your first frame. Good luck!</i>`; keyboardRows[0].shift(); }
    
    const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
    const sentMsg = await queuedSendMessage(liveSession.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
    if (sentMsg) {
        gameState.lastMessageId = sentMsg.message_id;
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
    }
}
async function handleKingpinsChallengeContinue(session) {
    const gameState = session.game_state_json;
    let frameResult = {};
    const roll1 = rollDice();
    if (roll1 === 1) { await finalizeGame(session, 'completed_loss'); return; }
    if (roll1 === 6) {
        gameState.currentMultiplier *= NEW_BOWLING_MULTIPLIERS.STRIKE;
        frameResult = { result: 'Strike 💎', rolls: [6] };
    } else {
        const roll2 = rollDice();
        if (roll2 === 1) { await finalizeGame(session, 'completed_loss'); return; }
        const pinsFromFirstShot = NEW_BOWLING_PINS_PER_ROLL[roll1] || 0;
        const pinsFromSecondShot = NEW_BOWLING_PINS_PER_ROLL[roll2] || 0;
        if ((pinsFromFirstShot + pinsFromSecondShot) >= 10) {
            gameState.currentMultiplier *= NEW_BOWLING_MULTIPLIERS.SPARE;
            frameResult = { result: 'Spare ⭐', rolls: [roll1, roll2] };
        } else {
            gameState.currentMultiplier *= NEW_BOWLING_MULTIPLIERS.OPEN;
            frameResult = { result: 'Open Frame', rolls: [roll1, roll2] };
        }
    }
    gameState.frameHistory.push(frameResult);
    gameState.currentFrame++;
    if (gameState.currentFrame > NEW_BOWLING_FRAMES) { await finalizeGame(session, 'completed_cashout'); }
    else {
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updateKingpinsChallengeMessage(session, frameResult);
    }
}

// --- Bullseye Blitz (Fast PvB Darts) Game Logic ---
async function runBullseyeBlitz(session) {
    const gameState = session.game_state_json || {};
    gameState.currentRound = 1;
    gameState.totalScore = 0;
    gameState.currentMultiplier = 1.0;
    gameState.status = 'awaiting_decision';
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await updateBullseyeBlitzMessage(session);
}
async function updateBullseyeBlitzMessage(session, lastRoundResult = null) {
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [session.session_id]);
    if (res.rowCount === 0) return;
    const liveSession = res.rows[0];
    const gameState = liveSession.game_state_json;
    if (gameState.lastMessageId) { await bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(() => {}); }

    const betDisplayUSD = await formatBalanceForDisplay(liveSession.bet_amount_lamports, 'USD');
    const currentPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
    const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');
    let titleHTML = `🎯 <b>Bullseye Blitz</b> | ${escape(gameState.p1Name)}\n`;
    let bodyHTML = `Wager: <b>${escape(betDisplayUSD)}</b>\n\n`;
    if (lastRoundResult) { bodyHTML += `<i>Last Round's Darts: [${lastRoundResult.rolls.join(', ')}] scored ${lastRoundResult.score} points!</i>\n`; }
    bodyHTML += `Total Score: <b>${gameState.totalScore}</b> | Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b>\n`;
    bodyHTML += `Current Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;
    
    let promptHTML = `<i>Round ${gameState.currentRound}/${BLITZ_DARTS_ROUNDS}. Ready to throw?</i>`;
    const keyboardRows = [[
        { text: `💰 Cash Out (${currentPayoutDisplay})`, callback_data: `interactive_cashout:${liveSession.session_id}` },
        { text: `▶️ Throw Darts`, callback_data: `interactive_continue:${liveSession.session_id}` }
    ]];
    if (gameState.currentRound === 1 && !lastRoundResult) { promptHTML = `<i>Your first round. Go for the bullseye!</i>`; keyboardRows[0].shift(); }
    
    const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
    const sentMsg = await queuedSendMessage(liveSession.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
    if (sentMsg) {
        gameState.lastMessageId = sentMsg.message_id;
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
    }
}
async function handleBullseyeBlitzContinue(session) {
    const gameState = session.game_state_json;
    const rolls = [rollDice(), rollDice()];
    if (rolls.every(r => r <= BLITZ_DARTS_BUST_ROLL_MAX)) { await finalizeGame(session, 'completed_loss'); return; }
    
    const scoreThisRound = rolls.reduce((sum, roll) => sum + (BLITZ_DARTS_POINTS_PER_ROLL[roll] || 0), 0);
    gameState.totalScore += scoreThisRound;
    gameState.currentMultiplier = BLITZ_DARTS_MULTIPLIERS[gameState.currentRound - 1];
    
    const roundResult = { rolls, score: scoreThisRound };
    gameState.currentRound++;

    if (gameState.currentRound > BLITZ_DARTS_ROUNDS) { await finalizeGame(session, 'completed_cashout'); }
    else {
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await updateBullseyeBlitzMessage(session, roundResult);
    }
}

// --- Performance-Based Darts 501 Challenge (PvB) Game Logic ---
async function runDarts501Challenge(session) {
    const gameState = session.game_state_json || {};
    gameState.remainingScore = DARTS_501_START_SCORE;
    gameState.currentVisit = 1;
    gameState.visitHistory = [];
    gameState.currentMultiplier = 1.0;
    gameState.status = 'awaiting_decision';
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await updateDarts501Message(session);
}
async function updateDarts501Message(session, lastVisitResult = null) {
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [session.session_id]);
    if (res.rowCount === 0) return;
    const liveSession = res.rows[0];
    const gameState = liveSession.game_state_json;
    if (gameState.lastMessageId) { await bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(() => {}); }

    const parScoreForThisStage = DARTS_501_START_SCORE - ((gameState.currentVisit - 1) * DARTS_501_PAR_SCORE_PER_VISIT);
    const scoreDifference = parScoreForThisStage - gameState.remainingScore;
    const tenPointIntervals = Math.round(scoreDifference / 10);
    let multiplierBonus = (tenPointIntervals > 0) ? (tenPointIntervals * DARTS_501_MULTIPLIER_GAIN) : (tenPointIntervals * DARTS_501_MULTIPLIER_LOSS);
    gameState.currentMultiplier = 1.0 + multiplierBonus;
    
    const betDisplayUSD = await formatBalanceForDisplay(liveSession.bet_amount_lamports, 'USD');
    const currentPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
    const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');

    let titleHTML = `🎯 <b>Darts 501 Challenge</b> | ${escape(gameState.p1Name)}\n`;
    titleHTML += `<b>Visits Remaining: ${DARTS_501_VISIT_LIMIT - gameState.currentVisit + 1} / ${DARTS_501_VISIT_LIMIT}</b>\n\n`;
    let bodyHTML = ``;
    if (lastVisitResult) {
        if (lastVisitResult.isBust) { bodyHTML += `<i>Last Visit: BUST! Throws <b>[${lastVisitResult.rolls.join(', ')}]</b> exceeded score. No points deducted.</i>\n`; }
        else { bodyHTML += `<i>Last Visit: Throws <b>[${lastVisitResult.rolls.join(', ')}]</b> scored <b>${lastVisitResult.score}</b> points!</i>\n`; }
    }
    bodyHTML += `Score Remaining: <b>${gameState.remainingScore}</b>\n`;
    bodyHTML += `Multiplier (vs Par): <b>x${gameState.currentMultiplier.toFixed(2)}</b> | Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;

    let promptHTML = `<i>Visit ${gameState.currentVisit}/${DARTS_501_VISIT_LIMIT}. Ready to throw?</i>`;
    const keyboardRows = [[
        { text: `💰 Cash Out (${currentPayoutDisplay})`, callback_data: `interactive_cashout:${liveSession.session_id}` },
        { text: `▶️ Throw Next Darts`, callback_data: `interactive_continue:${liveSession.session_id}` }
    ]];
    if (gameState.currentVisit === 1) { keyboardRows[0].shift(); }
    
    const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
    const sentMsg = await queuedSendMessage(liveSession.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
    if (sentMsg) {
        gameState.lastMessageId = sentMsg.message_id;
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
    }
}
async function handleDarts501Continue(session) {
    const gameState = session.game_state_json;
    const rolls = [rollDice(), rollDice()];
    const scoreThisVisit = rolls.reduce((sum, roll) => sum + (BLITZ_DARTS_POINTS_PER_ROLL[roll] || 0), 0);
    let lastVisitResult = { rolls, score: scoreThisVisit, isBust: false };
    const scoreAfterThrow = gameState.remainingScore - scoreThisVisit;

    if (scoreAfterThrow === 0) {
        gameState.currentMultiplier = DARTS_501_JACKPOT_MULTIPLIER;
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await finalizeGame(session, 'completed_cashout');
        return;
    } else if (scoreAfterThrow < 0 || scoreAfterThrow === 1) {
        lastVisitResult.isBust = true;
    } else {
        gameState.remainingScore = scoreAfterThrow;
    }

    gameState.visitHistory.push(lastVisitResult);
    gameState.currentVisit++;

    if (gameState.currentVisit > DARTS_501_VISIT_LIMIT) { await finalizeGame(session, 'completed_loss'); return; }
    
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await updateDarts501Message(session, lastVisitResult);
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
        
        if (gameType.includes('_pvp')) {
            gameState.p1Rolls = []; gameState.p1Score = 0;
            gameState.p2Rolls = []; gameState.p2Score = 0;
        }
        
        gameState.p1Name = gameState.initiatorName || "Player 1";
        gameState.currentPlayerTurn = String(gameState.initiatorId || liveSession.user_id);
        if (gameType.includes('_pvp')) gameState.p2Name = gameState.opponentName || "Player 2";
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await client.query('COMMIT');

        // Route to the appropriate game loop
        if (gameType === 'basketball') { await runRoundBasedHoops(liveSession); } 
        else if (gameType === 'bowling') { await runKingpinsChallenge(liveSession); }
        else if (gameType === 'darts') { await runBullseyeBlitz(liveSession); }
        else if (gameType === 'darts_501') { await runDarts501Challenge(liveSession); }
        else if (gameType.includes('_pvp')) { await advancePvPGameState(liveSession.session_id); }
        else { console.error(`${logPrefix} Unknown game type to start: ${gameType}`); await finalizeGame(liveSession, 'error'); }
    } catch (e) { if (client) await client.query('ROLLBACK'); console.error(`${logPrefix} Error initializing game: ${e.message}`); } finally { if (client) client.release(); }
}
async function advancePvPGameState(sessionId) {
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
    if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;
    const session = res.rows[0];
    const gameState = session.game_state_json || {};
    const shotsPerPlayer = getShotsPerPlayer(session.game_type);
    const p1_done = (gameState.p1Rolls || []).length >= shotsPerPlayer;
    const p2_done = (gameState.p2Rolls || []).length >= shotsPerPlayer;
    if (p1_done && p2_done) { await finalizeGame(session, 'pvp_resolve'); return; }
    gameState.currentPlayerTurn = !p1_done ? String(gameState.initiatorId) : String(gameState.opponentId);
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
    await promptPvPAction(session, gameState);
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
    if (session.status !== 'in_progress') return;
    if (session.game_type.includes('_pvp')) {
        const gameState = session.game_state_json || {};
        const playerKey = (String(gameState.initiatorId) === gameState.currentPlayerTurn) ? 'p1' : 'p2';
        if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
        gameState[`${playerKey}Rolls`].push(lastRoll);
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await advancePvPGameState(session.session_id);
    }
}
async function finalizeGame(session, finalStatus) {
    const sessionId = session.session_id;
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
    } catch (e) { if(client) await client.query('ROLLBACK'); console.error(`[FinalizeGame SID:${sessionId}] Error: ${e.message}`); } finally { if(client) client.release(); }
}

// --- EVENT HANDLERS & MAIN LOOP ---
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const fromId = String(callbackQuery.from.id);
    if (!data) return;
    const [action, sessionId] = data.split(':');

    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
    if (res.rowCount === 0 || res.rows[0].status !== 'in_progress' || String(res.rows[0].user_id) !== fromId) {
        return bot.answerCallbackQuery(callbackQuery.id).catch(()=>{});
    }
    const session = res.rows[0];

    if (action === 'interactive_cashout') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Cashing out..." }).catch(() => {});
        await finalizeGame(session, 'completed_cashout');
    } else if (action === 'interactive_continue') {
        await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
        const gameType = session.game_type;
        if (gameType === 'bowling') { await handleKingpinsChallengeContinue(session); }
        else if (gameType === 'basketball') { await handleRoundBasedHoopsContinue(session); }
        else if (gameType === 'darts') { await handleBullseyeBlitzContinue(session); }
        else if (gameType === 'darts_501') { await handleDarts501Continue(session); }
    }
});
async function handleGameTimeout(sessionId) {
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
    if (res.rowCount > 0 && res.rows[0].status === 'in_progress') { await finalizeGame(res.rows[0], 'completed_timeout'); }
}
async function handleNotification(msg) {
    try {
        const payload = JSON.parse(msg.payload);
        const mainBotGameId = payload.session?.main_bot_game_id || payload.main_bot_game_id;
        const sessionId = payload.session?.session_id || payload.session_id;

        if (msg.channel === 'game_session_pickup' && mainBotGameId) {
            const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE main_bot_game_id = $1", [mainBotGameId]);
            if (res.rows.length > 0) await handleGameStart(res.rows[0]);
        } else if (msg.channel === 'interactive_roll_submitted' && sessionId) {
            const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
            if (res.rows.length > 0) {
                const lastRoll = res.rows[0].game_state_json?.lastRoll;
                if (typeof lastRoll === 'number') { await handleRollSubmitted(res.rows[0], lastRoll); }
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
async function getSolUsdPrice() { const cached = solPriceCache.get(SOL_PRICE_CACHE_KEY); if (cached && (Date.now() - cached.timestamp < SOL_USD_PRICE_CACHE_TTL_MS)) return cached.price; try { const price = parseFloat((await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 8000 })).data?.price); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e) { try { const price = parseFloat((await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 8000 })).data?.solana?.usd); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e2) { if (cached) return cached.price; throw new Error("Could not retrieve SOL/USD price."); } }}
function convertLamportsToUSDString(lamports, solUsdPrice, d = 2) { if (typeof solUsdPrice !== 'number' || solUsdPrice <= 0) return 'N/A'; const sol = Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL); return `$${(sol * solUsdPrice).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;}
async function formatBalanceForDisplay(lamports, currency = 'USD') { if (currency === 'USD') { try { const price = await getSolUsdPrice(); return convertLamportsToUSDString(lamports, price); } catch (e) { return 'N/A'; } } return `${(Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL)).toFixed(SOL_DECIMALS)} SOL`;}
function getShotsPerPlayer(gameType) { const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return PVP_BOWLING_FRAMES; if (lt.includes('basketball_clash_pvp')) return PVP_BASKETBALL_SHOTS; if (lt.includes('darts_duel_pvp')) return PVP_DARTS_THROWS; return 1; }
function calculateFinalScore(gameType, rolls) { const safeRolls = rolls || []; if (safeRolls.length === 0) return 0; if (gameType.includes('basketball')) return safeRolls.filter(r => r >= 4).length; return safeRolls.reduce((a, b) => a + b, 0); }
function getCleanGameNameHelper(gameType) {
    if (!gameType) return "Game";
    const lt = String(gameType).toLowerCase();
    if (lt.includes('bowling_duel_pvp')) return "Bowling Duel";
    if (lt.includes('darts_duel_pvp')) return "Darts Showdown";
    if (lt.includes('basketball_clash_pvp')) return "3-Point Clash";
    if (lt === 'bowling') return "Kingpin's Challenge";
    if (lt === 'darts') return "Bullseye Blitz";
    if (lt === 'darts_501') return "Darts 501 Challenge";
    if (lt === 'basketball') return "Round-Based Hoops";
    return "Game";
}
function getGameEmoji(gameType) { if (gameType.includes('bowling')) return '🎳'; if (gameType.includes('darts')) return '🎯'; if (gameType.includes('basketball')) return '🏀'; return '🎲'; }
function formatRollsHelper(rolls) { if (!rolls || rolls.length === 0) return '...'; return rolls.map(r => `<b>${r}</b>`).join(' '); }

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => { console.error("CRITICAL: Could not set up notification listeners.", e); process.exit(1); });
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
