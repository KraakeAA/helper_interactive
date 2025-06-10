// helper_bot.js - FINAL UNIFIED VERSION v15 - Basketball UI/Clarity Fixes, No Omissions

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
const PLAYER_ACTION_TIMEOUT = 120000;

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
const BOWLING_FRAMES = 10;
const KINGPIN_ROLL_EFFECTS = {
    6: { outcome: 'Strike 💎', multiplier_increase: 1.8 },
    5: { outcome: 'Hit 👍', multiplier_increase: 1.25 },
    4: { outcome: 'Hit 👍', multiplier_increase: 1.15 },
    3: { outcome: 'Gutter 🟡', multiplier_increase: 0.5 },
    2: { outcome: 'Gutter 🟡', multiplier_increase: 0.4 },
    1: { outcome: 'BUST 💥', multiplier_increase: 0.0 }
};
const DARTS_THROWS_TOTAL = 5;
const BULLSEYE_BLITZ_EFFECTS = {
    6: { outcome: 'Bullseye! 🎯', multiplier_increase: 2.0 },
    5: { outcome: 'Inner Circle 👍', multiplier_increase: 1.3 },
    4: { outcome: 'Inner Circle 👍', multiplier_increase: 1.2 },
    3: { outcome: 'Outer Ring 🟡', multiplier_increase: 0.6 },
    2: { outcome: 'Outer Ring 🟡', multiplier_increase: 0.5 },
    1: { outcome: 'MISS! 💥', multiplier_increase: 0.0 }
};
const PVP_BOWLING_FRAMES = 3;
const PVP_BASKETBALL_SHOTS = 5;
const PVP_DARTS_THROWS = 3;
const THREE_POINT_PAYOUTS = [1.5, 2.2, 3.5, 5.0, 10.0, 20.0, 50.0];
const PINPOINT_BOWLING_PAYOUT_MULTIPLIER = 5.5;
const DARTS_FORTUNE_PAYOUTS = { 6: 3.5, 5: 1.5, 4: 0.5, 3: 0.2, 2: 0.1, 1: 0.0 };

// --- NEW: Round-Based Basketball (PvB) Game Constants ---
const ROUND_BASED_HOOPS_ROUNDS = 5;
const ROUND_BASED_HOOPS_SHOTS_PER_ROUND = 2;
const ROUND_BASED_HOOPS_EFFECTS = {
    6: { outcome: 'Swish!', emoji: '🎯', multiplier_effect: 1.5 },   // Good positive
    5: { outcome: 'Nice Shot!', emoji: '👍', multiplier_effect: 1.2 },   // Slight positive
    4: { outcome: 'Rim In!', emoji: '⚪️', multiplier_effect: 1.0 },   // Neutral
    3: { outcome: 'Rim Out!', emoji: '🟡', multiplier_effect: 0.75 },  // Negative
    2: { outcome: 'Bad Miss!', emoji: '🟡', multiplier_effect: 0.5 },   // Negative
    1: { outcome: 'Airball!', emoji: '💥', multiplier_effect: 0.0 }    // Bust
};


// --- Database & Bot Setup ---
if (!HELPER_BOT_TOKEN || !DATABASE_URL) {
    console.error("❌ CRITICAL: HELPER_BOT_TOKEN or DATABASE_URL is missing. Helper bot cannot start.");
    process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new TelegramBot(HELPER_BOT_TOKEN, { polling: { params: { allowed_updates: ["message", "callback_query"] } } });
bot.on('polling_error', (error) => console.error(`[Helper] Polling Error: ${error.code} - ${error.message}`));
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1000 / 20, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));

// --- NEW: Round-Based Hoops (PvB Basketball) Game Logic ---

/**
 * Entry point and state initializer for the Round-Based Hoops game.
 * @param {object} session The game session data from the database.
 */
async function runRoundBasedHoops(session) {
    const logPrefix = `[RunRoundBasedHoops SID:${session.session_id}]`;
    console.log(`${logPrefix} Starting Round-Based Hoops logic.`);
    let client = null;
    try {
        client = await pool.connect();
        const gameState = session.game_state_json || {};
        
        // Initialize game state for a new game
        gameState.currentRound = 1;
        gameState.shotsTakenInRound = 0;
        gameState.rolls = [];
        gameState.currentMultiplier = 1.0;
        gameState.status = 'awaiting_shots';

        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        
        await updateRoundBasedHoopsMessage(session.session_id);

    } catch (e) {
        console.error(`${logPrefix} Error starting game: ${e.message}`);
        await finalizeGame(session, 'error');
    } finally {
        if (client) client.release();
    }
}

/**
 * Creates and updates the game message for Round-Based Hoops.
 * @param {number} sessionId The database ID of the session.
 */
async function updateRoundBasedHoopsMessage(sessionId) {
    const logPrefix = `[UpdateRoundBasedHoopsMsg SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) return;
        
        const session = res.rows[0];
        const gameState = session.game_state_json;

        if (activeTurnTimeouts.has(sessionId)) {
            clearTimeout(activeTurnTimeouts.get(sessionId));
            activeTurnTimeouts.delete(sessionId);
        }

        if (gameState.lastMessageId) {
            await bot.deleteMessage(session.chat_id, gameState.lastMessageId).catch(() => {});
        }

        const betDisplayUSD = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
        const gameName = "Round-Based Hoops";
        const currentPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100))) / 100n;
        const currentPayoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');

        let titleHTML = `🏀 <b>${escape(gameName)}</b> 🏀\n\n`;
        let bodyHTML = `Player: <b>${escape(gameState.p1Name)}</b> | Wager: <b>${escape(betDisplayUSD)}</b>\n\n`;
        
        let progressIcons = "";
        for (let i = 1; i <= ROUND_BASED_HOOPS_ROUNDS; i++) {
            progressIcons += (i < gameState.currentRound) ? "✅ " : (i === gameState.currentRound ? "🎯 " : "⚪️ ");
        }
        bodyHTML += `Progress: ${progressIcons}\nRound: <b>${gameState.currentRound} / ${ROUND_BASED_HOOPS_ROUNDS}</b>\n\n`;

        // Create the detailed shot log
        let shotLogHTML = "<b>Shot Log:</b>\n";
        if (gameState.rolls.length > 0) {
            gameState.rolls.forEach((roll, index) => {
                const roundForShot = Math.floor(index / ROUND_BASED_HOOPS_SHOTS_PER_ROUND) + 1;
                const shotInRound = (index % ROUND_BASED_HOOPS_SHOTS_PER_ROUND) + 1;
                const effect = ROUND_BASED_HOOPS_EFFECTS[roll];
                shotLogHTML += `  R${roundForShot}, S${shotInRound}: Rolled <b>${roll}</b> ${effect.emoji} (${effect.outcome})\n`;
            });
        } else {
            shotLogHTML += "<i>No shots taken yet.</i>\n";
        }
        bodyHTML += `${shotLogHTML}\n`;

        bodyHTML += `Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b>\n`;
        bodyHTML += `Current Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;

        const keyboardRows = [];
        let promptHTML = "";

        if (gameState.status === 'awaiting_shots') {
            const shotsRemaining = ROUND_BASED_HOOPS_SHOTS_PER_ROUND - gameState.shotsTakenInRound;
            promptHTML = `Please send <b>${shotsRemaining}</b> 🏀 emoji(s) to take your shot(s) for Round ${gameState.currentRound}.`;
        } else if (gameState.status === 'awaiting_cashout_decision') {
            promptHTML = `<b>Round ${gameState.currentRound} Complete!</b>\nSend a 🏀 to start the next round, or cash out your winnings now.`;
            keyboardRows.push([
                { text: `💰 Cash Out (${escape(currentPayoutDisplay)})`, callback_data: `interactive_cashout:${sessionId}` }
            ]);
        }

        const fullMessage = `${titleHTML}${bodyHTML}<i>${promptHTML}</i>`;
        const sentMsg = await queuedSendMessage(session.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } });
        
        if (sentMsg) {
            gameState.lastMessageId = sentMsg.message_id;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            const timeoutId = setTimeout(() => handleGameTimeout(sessionId), PLAYER_ACTION_TIMEOUT);
            activeTurnTimeouts.set(sessionId, timeoutId);
        }
    } catch (e) {
        console.error(`${logPrefix} Error: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

/**
 * Handles a player's roll in Round-Based Hoops.
 * @param {object} session The game session data.
 * @param {number} rollValue The value of the dice roll.
 */
async function handleRoundBasedHoopsRoll(session, rollValue) {
    const logPrefix = `[HandleRoundBasedHoopsRoll SID:${session.session_id}]`;
    const gameState = session.game_state_json;

    // If player sends a roll when they should be cashing out/continuing, treat it as continuing.
    if (gameState.status === 'awaiting_cashout_decision') {
        gameState.currentRound++;
        gameState.shotsTakenInRound = 0; // Reset for the new round
        gameState.status = 'awaiting_shots';
    }

    if (gameState.status !== 'awaiting_shots') return;

    const effect = ROUND_BASED_HOOPS_EFFECTS[rollValue];
    if (!effect) {
        console.error(`${logPrefix} Invalid roll value: ${rollValue}`);
        return;
    }

    // Give immediate feedback on the roll
    const feedbackMsg = await queuedSendMessage(session.chat_id, `You rolled a <b>${rollValue}</b>... ${effect.emoji} (${effect.outcome})`, { parse_mode: 'HTML' });
    if(feedbackMsg) {
        setTimeout(() => bot.deleteMessage(session.chat_id, feedbackMsg.message_id).catch(() => {}), 3000);
    }
    
    // 1. Check for instant loss
    if (effect.multiplier_effect === 0.0) {
        await finalizeGame(session, 'completed_loss'); // Bust
        return;
    }

    // 2. Update state with the new roll
    gameState.rolls.push(rollValue);
    gameState.shotsTakenInRound++;
    gameState.currentMultiplier = (gameState.currentMultiplier * effect.multiplier_effect);

    // 3. Check if the round is complete
    if (gameState.shotsTakenInRound >= ROUND_BASED_HOOPS_SHOTS_PER_ROUND) {
        // If this was the final round, cash out automatically
        if (gameState.currentRound >= ROUND_BASED_HOOPS_ROUNDS) {
            await finalizeGame(session, 'completed_cashout');
        } else {
            // Otherwise, prompt for decision
            gameState.status = 'awaiting_cashout_decision';
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await updateRoundBasedHoopsMessage(session.session_id);
        }
    } else {
        // Round is not over, silently wait for the next roll and save state
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        // No UI update here, we wait for the second shot of the round.
    }
}

// --- End of NEW Round-Based Hoops Logic ---


// --- GAME ENGINE & STATE MACHINE ---

async function handleGameStart(session) {
    const logPrefix = `[HandleStart_V9_Fix SID:${session.session_id}]`;
    console.log(`${logPrefix} Initializing game: ${session.game_type}`);
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const updateRes = await client.query(
            "UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2 AND status = 'pending_pickup' RETURNING *",
            [MY_BOT_ID, session.session_id]
        );

        if (updateRes.rowCount === 0) {
            await client.query('ROLLBACK');
            console.log(`${logPrefix} Game already picked up by another process. Aborting.`);
            return;
        }
        
        const liveSession = updateRes.rows[0];
        const gameState = liveSession.game_state_json || {};
        const gameType = liveSession.game_type;
        
        // --- Initialize game state for all types FIRST ---
        const isPressYourLuck = ['bowling', 'darts'].includes(gameType) && !gameType.includes('_pvp');
        const isNewPvPDuel = gameType.includes('_pvp');
        
        if (gameType === 'basketball') {
            // Initialization is now handled within runRoundBasedHoops
        } else if (isPressYourLuck) {
            gameState.turn = 1;
            gameState.rolls = [];
            gameState.currentMultiplier = 1.0;
        } else if (isNewPvPDuel) {
            gameState.p1Rolls = []; gameState.p1Score = 0;
            gameState.p2Rolls = []; gameState.p2Score = 0;
        }
        
        gameState.p1Name = gameState.initiatorName || "Player 1";
        gameState.currentPlayerTurn = String(gameState.initiatorId || liveSession.user_id);
        if (gameState.gameMode === 'pvp') gameState.p2Name = gameState.opponentName || "Player 2";
        
        // Save the initialized state and COMMIT the transaction
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await client.query('COMMIT');

        // --- NOW, call the appropriate game loop AFTER committing ---
        if (gameType === 'basketball') {
            await runRoundBasedHoops(liveSession);
        } else if (isPressYourLuck) {
            await updateKingpinChallengeState(liveSession.session_id);
        } else if (isNewPvPDuel) {
            await advancePvPGameState(liveSession.session_id);
        } else {
             // Handle legacy or unknown games
             console.error(`${logPrefix} Unknown game type to start: ${gameType}`); 
             await finalizeGame(liveSession, 'error');
        }
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error initializing game: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

async function updateKingpinChallengeState(sessionId) {
    const logPrefix = `[UpdateKingpinState_V2 SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;

        const session = res.rows[0];
        const gameState = session.game_state_json;
        const rolls = gameState.rolls || [];
        const numRolls = rolls.length;
        const gameType = session.game_type;
        const { maxTurns, emoji, effects } = getPressYourLuckConfig(gameType);

        const lastRoll = rolls[numRolls - 1];
        if (lastRoll === 1) {
            await finalizeGame(session, 'completed_loss');
            return;
        }
        if (numRolls >= maxTurns) {
            await finalizeGame(session, 'completed_cashout');
            return;
        }

        if (gameState.lastMessageId) {
            await bot.deleteMessage(session.chat_id, gameState.lastMessageId).catch(() => {});
        }

        const betDisplay = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
        const gameName = getCleanGameNameHelper(gameType);
        let messageHTML = `<b>${emoji} ${escape(gameName)} ${emoji}</b>\n\n` +
                          `Player: <b>${escape(gameState.p1Name)}</b> | Wager: <b>${escape(betDisplay)}</b>\n` +
                          `Multiplier: <b>x${gameState.currentMultiplier.toFixed(2)}</b>\n\n`;

        let rollsDisplay = "";
        for (let i = 0; i < maxTurns; i++) {
            rollsDisplay += `[${rolls[i] || '_'}] `;
            if ((i + 1) % 3 === 0 && i < maxTurns - 1) rollsDisplay += " ";
        }
        messageHTML += `Rolls: <code>${rollsDisplay.trim()}</code>\n\n`;

        const keyboard = { inline_keyboard: [] };
        let callToAction = "";

        if (numRolls > 0 && numRolls % 3 === 0) {
            const currentPayout = BigInt(session.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100)) / 100n;
            const cashoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');
            if (numRolls === 9) {
                 callToAction = `Final round complete! Cash out now, or send one final 🎳 for an all-or-nothing win!`;
            } else {
                 callToAction = `Round complete! Send 3 🎳 to continue, or cash out.`;
            }
            keyboard.inline_keyboard.push([{ text: `💰 Cash Out (${cashoutDisplay})`, callback_data: `interactive_cashout:${sessionId}` }]);
        } else {
            const roundNum = Math.floor(numRolls / 3) + 1;
            const rollInRound = (numRolls % 3) + 1;
            callToAction = `Round ${roundNum}, Roll ${rollInRound}/3. Send 🎳 to roll.`;
        }
        messageHTML += `<i>${callToAction}</i>`;
        
        const messageOptions = { parse_mode: 'HTML', reply_markup: keyboard };
        const sentMsg = await queuedSendMessage(session.chat_id, messageHTML, messageOptions);
        
        if (sentMsg) {
            gameState.lastMessageId = sentMsg.message_id;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            if (activeTurnTimeouts.has(sessionId)) clearTimeout(activeTurnTimeouts.get(sessionId));
            const timeoutId = setTimeout(() => handleGameTimeout(sessionId), PLAYER_ACTION_TIMEOUT);
            activeTurnTimeouts.set(sessionId, timeoutId);
        }
    } catch(e) {
        console.error(`${logPrefix} Error: ${e.message}`);
    } finally {
        if(client) client.release();
    }
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
        
        if (p1_done && p2_done) {
            await finalizeGame(session, 'pvp_resolve');
            return;
        }

        if (!p1_done) {
            gameState.currentPlayerTurn = String(gameState.initiatorId);
        } else {
            gameState.currentPlayerTurn = String(gameState.opponentId);
        }
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        await promptPvPAction(session, gameState);
    } catch (e) {
        console.error(`${logPrefix} Error advancing PvP game state: ${e.message}`);
        await finalizeGame({session_id: sessionId}, 'error');
    } finally {
        if (client) client.release();
    }
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

    let scoreBoardHTML = `<b>${p1Name}:</b> ${formatRollsHelper(p1Rolls || [])} ➠ Score: <b>${p1Score}</b>\n` +
                         `<b>${p2Name}:</b> ${formatRollsHelper(p2Rolls || [])} ➠ Score: <b>${p2Score}</b>`;

    let messageHTML = `⚔️ <b>${gameName}</b> ⚔️\n\n${scoreBoardHTML}\n\n` +
                      `It's your turn, <b>${nextPlayerName}</b>! Send a ${emoji} to roll (Roll ${nextPlayerRolls.length + 1} of ${shotsPerPlayer}).`;
                      
    await queuedSendMessage(chat_id, messageHTML, { parse_mode: 'HTML' });
}

async function handleRollSubmitted(session, lastRoll) {
    const logPrefix = `[HandleRoll SID:${session.session_id}]`;
    try {
        if (session.status !== 'in_progress') {
            console.warn(`${logPrefix} Roll received but game status is '${session.status}'. Ignoring.`);
            return;
        }

        if (session.game_type === 'basketball') {
            await handleRoundBasedHoopsRoll(session, lastRoll);
            return; 
        }
        
        const gameState = session.game_state_json || {};
        const currentPlayerId = gameState.currentPlayerTurn;

        const timeoutId = activeTurnTimeouts.get(session.session_id);
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeTurnTimeouts.delete(session.session_id);
        }

        if (session.game_type.includes('_pvp')) {
            const playerKey = (String(gameState.initiatorId) === currentPlayerId) ? 'p1' : 'p2';
            if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
            gameState[`${playerKey}Rolls`].push(lastRoll);
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await advancePvPGameState(session.session_id);
        } else { // For other PvB games like bowling/darts
            if (!gameState.rolls) gameState.rolls = [];
            gameState.rolls.push(lastRoll);
            gameState.lastRollValue = lastRoll;
            const effect = getPressYourLuckConfig(session.game_type).effects[lastRoll];
            gameState.currentMultiplier = (gameState.currentMultiplier || 1.0) * effect.multiplier_increase;
            gameState.turn++;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await updateKingpinChallengeState(session.session_id);
        }
    } catch (e) {
        console.error(`${logPrefix} Error handling submitted roll: ${e.message}`);
    }
}

async function finalizeGame(session, finalStatus) {
    const sessionId = session.session_id;
    const logPrefix = `[FinalizeGame SID:${sessionId}]`;
    const timeoutId = activeTurnTimeouts.get(sessionId);
    if (timeoutId) {
        clearTimeout(timeoutId);
        activeTurnTimeouts.delete(sessionId);
    }
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

        if (liveSession.game_type === 'basketball') {
            if (finalStatus === 'completed_cashout') {
                dbStatus = 'completed_cashout';
                const multiplier = gameState.currentMultiplier || 0;
                finalPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(multiplier * 100))) / 100n;
            } else { // bust, timeout, error, loss
                dbStatus = 'completed_loss';
                finalPayout = 0n;
            }
            gameState.finalStatus = dbStatus;
        } 
        else if (finalStatus === 'pvp_resolve') {
            const p1Score = calculateFinalScore(liveSession.game_type, gameState.p1Rolls);
            const p2Score = calculateFinalScore(liveSession.game_type, gameState.p2Rolls);
            gameState.p1Score = p1Score;
            gameState.p2Score = p2Score;
            if (p1Score > p2Score) dbStatus = 'completed_p1_win';
            else if (p2Score > p1Score) dbStatus = 'completed_p2_win';
            else dbStatus = 'completed_push';
        } else if (finalStatus === 'completed_cashout') {
            dbStatus = 'completed_cashout';
            const multiplier = gameState.currentMultiplier || 0;
            finalPayout = (BigInt(liveSession.bet_amount_lamports) * BigInt(Math.floor(multiplier * 100))) / 100n;
        } else if (finalStatus === 'completed_loss' || finalStatus === 'completed_timeout' || finalStatus === 'error') {
            dbStatus = 'completed_loss';
            finalPayout = 0n;
        }

        await client.query(
            "UPDATE interactive_game_sessions SET status = $1, final_payout_lamports = $2, game_state_json = $3 WHERE session_id = $4",
            [dbStatus, finalPayout.toString(), JSON.stringify(gameState), sessionId]
        );
        await client.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: sessionId })}'`);
        await client.query('COMMIT');
        
        if(gameState.lastMessageId) {
            await bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(()=>{});
        }
    } catch (e) {
        if(client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error finalizing game: ${e.message}`);
    } finally {
        if(client) client.release();
    }
}

// ===================================================================
// --- EVENT HANDLERS & MAIN LOOP ---
// ===================================================================

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (!data) return;

    if (data.startsWith('roundbased_hoops_continue:')) {
        await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
        const sessionId = data.split(':')[1];
        const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount > 0) {
            const session = res.rows[0];
            if(String(session.user_id) !== String(callbackQuery.from.id)) return;
            // Treat this as the user wanting to continue; the next roll emoji will advance the state.
            // We just need to update the prompt.
            const gameState = session.game_state_json;
            gameState.currentRound++;
            gameState.shotsTakenInRound = 0;
            gameState.status = 'awaiting_shots';
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            await updateRoundBasedHoopsMessage(sessionId);
        }
        return;
    }

    if (data && data.startsWith('interactive_cashout:')) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Cashing out..." }).catch(() => {});
        const sessionId = data.split(':')[1];
        const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount > 0 && res.rows[0].status === 'in_progress') {
            const session = res.rows[0];
            if(String(session.user_id) !== String(callbackQuery.from.id)) return;
            await finalizeGame(session, 'completed_cashout');
        }
    }
});

async function handleGameTimeout(sessionId) {
    console.log(`[GameTimeout SID:${sessionId}] Player turn timed out.`);
    const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
    if (res.rowCount > 0 && res.rows[0].status === 'in_progress') {
        await finalizeGame(res.rows[0], 'completed_timeout');
    }
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
                const fullSessionData = res.rows[0];
                const lastRoll = fullSessionData.game_state_json?.lastRoll;
                if (typeof lastRoll === 'number') {
                    await handleRollSubmitted(fullSessionData, lastRoll);
                } else {
                    console.error(`[Helper] Roll notification received for SID:${sessionId}, but lastRoll not found in gameState.`);
                }
            }
        }
    } catch (e) { console.error('[Helper] Error processing notification payload:', e); }
}

async function setupNotificationListeners() {
    console.log("⚙️ [Helper] Setting up notification listeners...");
    const listeningClient = await pool.connect();
    listeningClient.on('error', (err) => {
        console.error('[Helper] Listener client error:', err);
        setTimeout(setupNotificationListeners, 5000);
    });
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
    } catch (e) { console.error(`[Helper Fallback Poller] Error: ${e.message}`); } finally {
        if (client) client.release();
        processPendingGames.isRunning = false;
    }
}
processPendingGames.isRunning = false;


// ===================================================================
// --- UTILITY FUNCTIONS ---
// ===================================================================

function escape(text) { if (text === null || typeof text === 'undefined') return ''; return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');}
function stringifyWithBigInt(obj) { return JSON.stringify(obj, (key, value) => (typeof value === 'bigint' ? value.toString() + 'n' : value), 2); }
async function fetchSolUsdPriceFromBinanceAPI() { try { const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 8000 }); if (response.data?.price) return parseFloat(response.data.price); throw new Error('Invalid price data from Binance API.'); } catch (error) { throw error; }}
async function fetchSolUsdPriceFromCoinGeckoAPI() { try { const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 8000 }); if (response.data?.solana?.usd) return parseFloat(response.data.solana.usd); throw new Error('Invalid price data from CoinGecko API.'); } catch (error) { throw error; }}
async function getSolUsdPrice() { const cached = solPriceCache.get(SOL_PRICE_CACHE_KEY); if (cached && (Date.now() - cached.timestamp < SOL_USD_PRICE_CACHE_TTL_MS)) return cached.price; try { const price = await fetchSolUsdPriceFromBinanceAPI(); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e) { try { const price = await fetchSolUsdPriceFromCoinGeckoAPI(); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e2) { if (cached) return cached.price; throw new Error("Could not retrieve SOL/USD price from any source."); } }}
function convertLamportsToUSDString(lamports, solUsdPrice, d = 2) { if (typeof solUsdPrice !== 'number' || solUsdPrice <= 0) return 'N/A'; const sol = Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL); return `$${(sol * solUsdPrice).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;}
async function formatBalanceForDisplay(lamports, currency = 'USD') { if (currency === 'USD') { try { const price = await getSolUsdPrice(); return convertLamportsToUSDString(lamports, price); } catch (e) { return 'N/A'; } } return `${(Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL)).toFixed(SOL_DECIMALS)} SOL`;}
function getPressYourLuckConfig(gameType) { switch(gameType) { case 'bowling': return { maxTurns: BOWLING_FRAMES, effects: KINGPIN_ROLL_EFFECTS, emoji: '🎳' }; case 'darts': return { maxTurns: DARTS_THROWS_TOTAL, effects: BULLSEYE_BLITZ_EFFECTS, emoji: '🎯' }; case 'basketball': return { maxTurns: Infinity, effects: ROUND_BASED_HOOPS_EFFECTS, emoji: '🏀' }; default: return { maxTurns: 1, effects: {}, emoji: '🎲' }; }}
function getShotsPerPlayer(gameType) { const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return PVP_BOWLING_FRAMES; if (lt.includes('basketball_clash_pvp')) return PVP_BASKETBALL_SHOTS; if (lt.includes('darts_duel_pvp')) return PVP_DARTS_THROWS; return 1; }
function calculateFinalScore(gameType, rolls) { const safeRolls = rolls || []; if (safeRolls.length === 0) return 0; if (gameType.includes('basketball')) return safeRolls.filter(r => r >= 4).length; return safeRolls.reduce((a, b) => a + b, 0); }
function getCleanGameNameHelper(gameType) { if (!gameType) return "Game"; const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return "Bowling Duel"; if (lt.includes('darts_duel_pvp')) return "Darts Showdown"; if (lt.includes('basketball_clash_pvp')) return "3-Point Clash"; if (lt === 'bowling') return "Kingpin's Challenge"; if (lt === 'darts') return "Bullseye Blitz"; if (lt === 'basketball') return "Round-Based Hoops"; return "Game"; }
function getGameEmoji(gameType) { if (gameType.includes('bowling')) return '🎳'; if (gameType.includes('darts')) return '🎯'; if (gameType.includes('basketball')) return '🏀'; return '🎲'; }
function formatRollsHelper(rolls) { if (!rolls || rolls.length === 0) return '...'; return rolls.map(r => `<b>${r}</b>`).join(' '); }

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => {
    console.error("CRITICAL: Could not set up notification listeners.", e);
    process.exit(1);
});
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
