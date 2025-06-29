// helper_bot.js - FINAL UNIFIED VERSION v34 - Corrected PvB Message Flow for API Limits

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
const PLAYER_ACTION_TIMEOUT = 45000;

// --- Basic Utilities ---
const PQueue = cjsPQueue.default ?? cjsPQueue;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Price Fetching & Formatting Dependencies ---
const SOL_DECIMALS = 9;
const solPriceCache = new Map();
const SOL_PRICE_CACHE_KEY = 'sol_usd_price_cache';
const SOL_USD_PRICE_CACHE_TTL_MS = 60 * 60 * 1000;

// --- In-Memory State ---
const activeTurnTimeouts = new Map();

// --- Game Constants ---

// Performance-Based Darts 501 Challenge (PvB - Solo) Constants
const DARTS_501_START_SCORE = 501;
const DARTS_501_VISIT_LIMIT = 8;
const DARTS_501_THROWS_PER_VISIT = 2;
const DARTS_501_POINTS_PER_ROLL = { 6: 60, 5: 50, 4: 40, 3: 20, 2: 7, 1: 1 };
const DARTS_501_PAR_SCORE_PER_VISIT = 75;
const DARTS_501_MULTIPLIER_GAIN = 0.15;
const DARTS_501_MULTIPLIER_LOSS = 0.10;
const DARTS_501_JACKPOT_MULTIPLIER = 10.00;

// Turn-Based PvB Duel Game Constants
const PVB_BOWLING_FRAMES = 3;
const PVB_BASKETBALL_SHOTS = 3;
const PVB_DARTS_THROWS = 3;

// Turn-Based Bowling Score Mapping
const PVB_BOWLING_SCORES = { 6: 10, 5: 8, 4: 6, 3: 4, 2: 2, 1: 0 };

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
// API Failsafe Queue: Ensures messages are sent sequentially and spaced out.
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1500, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));
const queuedSendDice = (chat_id, options) => telegramSendQueue.add(() => bot.sendDice(chat_id, options));


// --- Performance-Based Darts 501 Challenge (Solo PvB) Game Logic ---
// This game is unique and remains in its original format for variety.
async function runDarts501Challenge(session) {
    const gameState = session.game_state_json || {};
    gameState.remainingScore = DARTS_501_START_SCORE;
    gameState.currentVisit = 1;
    gameState.currentMultiplier = 1.0;
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
    const keyboardRows = [
        [{ text: `💰 Cash Out (${currentPayoutDisplay})`, callback_data: `interactive_cashout:${liveSession.session_id}` }],
        [{ text: `🎯 Throw Next Visit`, callback_data: `interactive_continue:${liveSession.session_id}` }]
    ];
    if (gameState.currentVisit === 1) { keyboardRows.shift(); }
    
    const fullMessage = `${titleHTML}${bodyHTML}${promptHTML}`;
    const sentMsg = await bot.sendMessage(liveSession.chat_id, fullMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboardRows } }).catch(console.error);
    if (sentMsg) {
        gameState.lastMessageId = sentMsg.message_id;
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
    }
}
async function handleDarts501Continue(session) {
    await bot.deleteMessage(session.chat_id, session.game_state_json.lastMessageId).catch(() => {});
    
    const dicePromises = Array.from({ length: DARTS_501_THROWS_PER_VISIT }, () => bot.sendDice(session.chat_id, { emoji: '🎯' }).catch(console.error));
    const diceMessages = await Promise.all(dicePromises);

    const rolls = diceMessages.map(msg => msg ? msg.dice.value : 1);
    if (rolls.includes(undefined) || rolls.includes(null)) { await finalizeGame(session, 'error'); return; }

    const gameState = session.game_state_json;
    const scoreThisVisit = rolls.reduce((sum, roll) => sum + (DARTS_501_POINTS_PER_ROLL[roll] || 0), 0);
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

    gameState.currentVisit++;
    if (gameState.currentVisit > DARTS_501_VISIT_LIMIT) { await finalizeGame(session, 'completed_loss'); return; }
    
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await updateDarts501Message(session, lastVisitResult);
}


// --- REVISED Turn-Based Player-vs-Bot (PvB) Game Engine (for API Limits) ---

function getPvBTotalTurns(gameType) {
    if (gameType === 'bowling') return PVB_BOWLING_FRAMES;
    if (gameType === 'basketball') return PVB_BASKETBALL_SHOTS;
    if (gameType === 'darts') return PVB_DARTS_THROWS;
    return 3;
}

// Starts the game and calls the message updater for the first time.
// in helper_bot.js - REPLACE this function
async function runPvBGame(session) {
    const gameState = session.game_state_json;
    gameState.playerScore = 0;
    gameState.botScore = 0;
    gameState.playerRolls = [];
    gameState.botRolls = [];
    gameState.currentTurn = 1;
    gameState.lastRoundResult = null; // Initialize last round result

    // Save the initialized state to the database
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    
    // Create the initial game board message to prompt the user for Round 1
    const gameName = getCleanGameNameHelper(session.game_type);
    const betDisplay = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
    const introText = `🔥🏀 <b>${escape(gameName)} vs. The Bot</b> 🏀🔥\n\nWager: <b>${escape(betDisplay)}</b>\n`;
    
    await updatePvBGameBoard(session.session_id, introText);
}

// The new central function for sending and editing the Game Board message.
async function updatePvBGameBoard(sessionId, introText = null) {
    const logPrefix = `[UpdatePvBBoardV3 SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) {
            console.warn(`${logPrefix} Session not found, cannot update board.`);
            return;
        }

        const session = res.rows[0];
        const gameState = session.game_state_json;
        const totalTurns = getPvBTotalTurns(session.game_type);
        const emoji = getGameEmoji(session.game_type);
        const gameName = getCleanGameNameHelper(session.game_type);
        const playerRef = escape(gameState.p1Name || "Player");

        // Build the message content with visuals
        let messageHTML = introText || `🔥🏀 <b>${escape(gameName)} vs. The Bot</b> 🏀🔥\n\n`;

        // Display the results from the last round if they exist
        if (gameState.lastRoundResult) {
            messageHTML += `<i>Last Round: ${gameState.lastRoundResult}</i>\n\n`;
        }

        messageHTML += `--- <b>Round ${gameState.currentTurn} of ${totalTurns}</b> ---\n`;
        messageHTML += `<b>Score:</b> ${playerRef} <b>${gameState.playerScore}</b> - <b>${gameState.botScore}</b> Bot 🤖\n\n`;
        messageHTML += `It's your turn, <b>${playerRef}</b>! Send a ${emoji} emoji **in this chat** to take your shot.`;

        const options = { parse_mode: 'HTML' };
        
        // Always send a new message for the round prompt
        const newMsg = await queuedSendMessage(session.chat_id, messageHTML, options);

        // Save the ID of this new message so it can be deleted before the next round's message
        if (newMsg) {
            gameState.gameBoardMessageId = newMsg.message_id;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        }
    } catch (error) {
        console.error(`${logPrefix} Error updating game board: ${error.message}`);
    } finally {
        if (client) client.release();
    }
}


// The rewritten turn handler with message editing and the requested delay.
async function handlePvBRoll(session, playerRollValue) {
    const { chat_id, game_type, game_state_json: gameState, session_id } = session;
    const emoji = getGameEmoji(game_type);
    const logPrefix = `[HandlePvBRollV3 SID:${session_id}]`;

    try {
        // 1. Delete the "prompt" message for the round that just finished
        if (gameState.gameBoardMessageId) {
            await bot.deleteMessage(chat_id, gameState.gameBoardMessageId).catch(() => {});
        }

        // 2. Bot takes its shot VISIBLY, immediately after the player's emoji is processed.
        const botDiceMessage = await queuedSendDice(chat_id, { emoji });
        if (!botDiceMessage || !botDiceMessage.dice) {
            throw new Error("Failed to send bot's dice roll message.");
        }
        const botRollValue = botDiceMessage.dice.value;

        // 3. Wait for the bot's dice animation to finish.
        await sleep(2500);
        
        // 4. Clean up the bot's dice message.
        if (botDiceMessage) await bot.deleteMessage(chat_id, botDiceMessage.message_id).catch(() => {});

        // 5. Calculate points for this round.
        let playerResultPoints = (playerRollValue >= 4) ? 1 : 0;
        let botResultPoints = (botRollValue >= 3) ? 1 : 0;

        // 6. Update the game state in memory.
        gameState.playerRolls.push(playerRollValue);
        gameState.botRolls.push(botRollValue);
        gameState.playerScore += playerResultPoints;
        gameState.botScore += botResultPoints;
        
        // 7. Create the result summary string to be included in the next prompt.
        const playerShotResult = playerResultPoints > 0 ? "You scored!" : "You missed.";
        const botShotResult = botResultPoints > 0 ? "Bot scores." : "Bot missed.";
        gameState.lastRoundResult = `${playerShotResult} (${playerRollValue}) | ${botShotResult} (${botRollValue})`;

        // 8. Check if the game is over.
        const totalTurns = getPvBTotalTurns(game_type);
        const isGameOver = (gameState.currentTurn >= totalTurns);

        // 9. Proceed to the next state.
        if (isGameOver) {
            await finalizeGame(session, 'pvb_resolve', gameState);
        } else {
            gameState.currentTurn++;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await updatePvBGameBoard(session.session_id); // This will now post the new combined message for the next round.
        }
    } catch (error) {
        console.error(`${logPrefix} Error during bot's turn: ${error.message}. Finalizing game with error state.`);
        await finalizeGame(session, 'error', gameState);
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
        
        gameState.p1Name = gameState.initiatorName || "Player 1";
        gameState.currentPlayerTurn = String(gameState.initiatorId || liveSession.user_id);
        if (gameType.includes('_pvp')) {
            gameState.p2Name = gameState.opponentName || "Player 2";
            gameState.p1Rolls = []; gameState.p1Score = 0;
            gameState.p2Rolls = []; gameState.p2Score = 0;
        }
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        
        const notifyPayload = JSON.stringify({ session: liveSession });
        await client.query(`NOTIFY game_session_pickup, '${notifyPayload}'`);
        await client.query('COMMIT');

        // --- Game Type Routing ---
        if (gameType === 'darts_501') {
            await runDarts501Challenge(liveSession);
        } else if (['bowling', 'basketball', 'darts'].includes(gameType)) {
            await runPvBGame(liveSession);
        } else if (gameType.includes('_pvp')) {
            await advancePvPGameState(liveSession.session_id);
        } else {
            console.error(`${logPrefix} Unknown game type to start: ${gameType}`);
            await finalizeGame(liveSession, 'error');
        }
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
    let messageHTML = `⚔️ <b>${gameName}</b> ⚔️\n\n${scoreBoardHTML}\n\n` + `It's your turn, <b>${nextPlayerName}</b>! Send a ${emoji} **in this chat** to roll (Roll ${nextPlayerRolls.length + 1} of ${shotsPerPlayer}).`;
    await queuedSendMessage(chat_id, messageHTML, { parse_mode: 'HTML' });
}
async function handleRollSubmitted(session, lastRoll) {
    if (session.status !== 'in_progress') return;
    const gameState = session.game_state_json || {};

    if (session.game_type.includes('_pvp')) {
        const playerKey = (String(gameState.initiatorId) === gameState.currentPlayerTurn) ? 'p1' : 'p2';
        if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
        gameState[`${playerKey}Rolls`].push(lastRoll);
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await advancePvPGameState(session.session_id);
    } else if (['bowling', 'basketball', 'darts'].includes(session.game_type)) {
        await handlePvBRoll(session, lastRoll);
    }
}
async function finalizeGame(session, finalStatus, updatedGameState = null) {
    const sessionId = session.session_id;
    const logPrefix = `[FinalizeGame_V5_Silent SID:${sessionId}]`;

    if (activeTurnTimeouts.has(sessionId)) { 
        clearTimeout(activeTurnTimeouts.get(sessionId));
        activeTurnTimeouts.delete(sessionId); 
    }
    
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const liveSessionRes = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
        if(liveSessionRes.rowCount === 0 || liveSessionRes.rows[0].status !== 'in_progress') {
            await client.query('ROLLBACK'); 
            return; 
        }
        
        const liveSession = liveSessionRes.rows[0];
        const gameState = updatedGameState || liveSession.game_state_json;
        let dbStatus = finalStatus;
        
        if (finalStatus === 'pvb_resolve') {
            const { p1Name, playerScore, botScore } = gameState;
            let resultText = '';
            if ((liveSession.game_type === 'bowling' || liveSession.game_type === 'darts') && playerScore === botScore) {
                dbStatus = 'completed_loss';
                resultText = `It's a draw, so the House wins. Better luck next time!`;
            } else if (liveSession.game_type === 'basketball' && playerScore === botScore) {
                dbStatus = 'completed_push';
                resultText = `It's a draw! Your wager has been returned.`;
            } else if (playerScore > botScore) {
                dbStatus = 'completed_win';
                resultText = `Congratulations, <b>${escape(p1Name)}</b>, you win!`;
            } else {
                dbStatus = 'completed_loss';
                resultText = `The Bot wins the duel.`;
            }
            let finalMsg = `--- 🏁 <b>Game Over</b> 🏁 ---\n\n`;
            finalMsg += `<b>Final Score:</b> ${escape(p1Name)} <b>${playerScore}</b> - <b>${botScore}</b> Bot\n\n`;
            finalMsg += `${resultText}`;
            // The main bot now sends the final result message, so the helper does not.
            // await queuedSendMessage(liveSession.chat_id, finalMsg, {parse_mode: 'HTML'});
            // await sleep(1000);
        } else if (finalStatus === 'pvp_resolve') {
            const p1Score = calculateFinalScore(liveSession.game_type, gameState.p1Rolls);
            const p2Score = calculateFinalScore(liveSession.game_type, gameState.p2Rolls);
            gameState.p1Score = p1Score; 
            gameState.p2Score = p2Score;
            if (p1Score > p2Score) dbStatus = 'completed_p1_win';
            else if (p2Score > p1Score) dbStatus = 'completed_p2_win';
            else dbStatus = 'completed_push';
        } else if (['completed_loss', 'completed_timeout', 'error'].includes(finalStatus)) {
            dbStatus = finalStatus === 'completed_timeout' ? 'completed_timeout' : 'completed_loss';
        } else if (finalStatus === 'completed_cashout') {
            dbStatus = 'completed_cashout';
        }

        gameState.finalStatus = dbStatus;
        
        // Delete the final game board message from the helper.
        if (gameState.gameBoardMessageId) {
            bot.deleteMessage(liveSession.chat_id, gameState.gameBoardMessageId).catch(() => {});
        } else if (gameState.lastPromptMessageId) { // Fallback for older state
             bot.deleteMessage(liveSession.chat_id, gameState.lastPromptMessageId).catch(() => {});
        }
        
        await client.query("UPDATE interactive_game_sessions SET status = $1, game_state_json = $2 WHERE session_id = $3", [dbStatus, JSON.stringify(gameState), sessionId]);
        await client.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: sessionId })}'`);
        await client.query('COMMIT');
        
    } catch (e) { 
        if(client) await client.query('ROLLBACK'); 
        console.error(`${logPrefix} Error: ${e.message}`); 
    } finally { 
        if(client) client.release(); 
    }
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

    // This logic is now primarily for Darts 501
    if (action === 'interactive_cashout') {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Cashing out..." }).catch(() => {});
        await finalizeGame(session, 'completed_cashout');
    } else if (action === 'interactive_continue') {
        await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
        if (session.game_type === 'darts_501') {
            await handleDarts501Continue(session);
        }
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
                if (typeof lastRoll === 'number') {
                    await handleRollSubmitted(res.rows[0], lastRoll);
                }
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
async function getSolUsdPrice() { const cached = solPriceCache.get(SOL_PRICE_CACHE_KEY); if (cached && (Date.now() - cached.timestamp < SOL_USD_PRICE_CACHE_TTL_MS)) return cached.price; try { const price = parseFloat((await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 8000 })).data?.price); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e) { try { const price = parseFloat((await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 8000 })).data?.solana?.usd); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return parseFloat(price); } catch (e2) { if (cached) return cached.price; throw new Error("Could not retrieve SOL/USD price."); } }}
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
    if (lt === 'basketball') return "3-Point Hoops";
    return "Game";
}
function getGameEmoji(gameType) { if (gameType.includes('bowling')) return '🎳'; if (gameType.includes('darts')) return '🎯'; if (gameType.includes('basketball')) return '🏀'; return '🎲'; }
function formatRollsHelper(rolls) { if (!rolls || rolls.length === 0) return '...'; return rolls.map(r => `<b>${r}</b>`).join(' '); }

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => { console.error("CRITICAL: Could not set up notification listeners.", e); process.exit(1); });
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
