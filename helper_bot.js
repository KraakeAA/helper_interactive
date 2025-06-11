// helper_bot.js - FINAL CONSOLIDATED & CORRECTED VERSION

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
const DARTS_501_START_SCORE = 501;
const DARTS_501_VISIT_LIMIT = 8;
const DARTS_501_THROWS_PER_VISIT = 2;
const DARTS_501_POINTS_PER_ROLL = { 6: 60, 5: 50, 4: 40, 3: 20, 2: 7, 1: 1 };
const DARTS_501_PAR_SCORE_PER_VISIT = 75;
const DARTS_501_MULTIPLIER_GAIN = 0.15;
const DARTS_501_MULTIPLIER_LOSS = 0.10;
const DARTS_501_JACKPOT_MULTIPLIER = 10.00;
const PVB_BOWLING_FRAMES = 3;
const PVB_BASKETBALL_SHOTS = 5;
const PVB_DARTS_THROWS = 3;
const PVB_BOWLING_SCORES = { 6: 10, 5: 8, 4: 6, 3: 4, 2: 2, 1: 0 };
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
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1500, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));
const queuedSendDice = (chat_id, options) => telegramSendQueue.add(() => bot.sendDice(chat_id, options));


// --- Performance-Based Darts 501 Challenge (Solo PvB) Game Logic ---
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
        else { bodyHTML += `<i>Last Visit: Throws <b>[<span class="math-inline">\{lastVisitResult\.rolls\.join\(', '\)\}\]</b\> scored <b\></span>{lastVisitResult.score}</b> points!</i>\n`; }
    }
    bodyHTML += `Score Remaining: <b>${gameState.remainingScore}</b>\n`;
    bodyHTML += `Multiplier (vs Par): <b>x${gameState.currentMultiplier.toFixed(2)}</b> | Payout: <b>${escape(currentPayoutDisplay)}</b>\n\n`;
    let promptHTML = `<i>Visit <span class="math-inline">\{gameState\.currentVisit\}/</span>{DARTS_501_VISIT_LIMIT}. Ready to throw?</i>`;
    const keyboardRows = [
        [{ text: `💰 Cash Out (${currentPayoutDisplay})`, callback_data: `interactive_cashout:${liveSession.session_id}` }],
        [{ text: `🎯 Throw Next Visit`, callback_data: `interactive_continue:${liveSession.session_id}` }]
    ];
    if (gameState.currentVisit === 1) { keyboardRows.shift(); }
    
    const fullMessage = `<span class="math-inline">\{titleHTML\}</span>{bodyHTML}${promptHTML}`;
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


// --- Turn-Based Player-vs-Bot (PvB) Game Engine ---
function getPvBTotalTurns(gameType) {
    if (gameType === 'bowling') return PVB_BOWLING_FRAMES;
    if (gameType === 'basketball') return PVB_BASKETBALL_SHOTS;
    if (gameType === 'darts') return PVB_DARTS_THROWS;
    return 3;
}
async function runPvBGame(session) {
    const gameState = session.game_state_json;
    gameState.playerScore = 0;
    gameState.botScore = 0;
    gameState.playerRolls = [];
    gameState.botRolls = [];
    gameState.currentTurn = 1;
    gameState.gameBoardMessageId = null;

    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    
    const gameName = getCleanGameNameHelper(session.game_type);
    const betDisplay = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
    let intro = `🔥 <b><span class="math-inline">\{escape\(gameName\)\} vs\. The Bot</b\> 🔥\\n\\nWager\: <b\></span>{escape(betDisplay)}</b>\n`;
    
    await updatePvBGameBoard(session.session_id, { intro });
}
async function updatePvBGameBoard(sessionId, override = {}) {
    const logPrefix = `[UpdatePvBBoard SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) return;

        const session = res.rows[0];
        const gameState = session.game_state_json;
        const totalTurns = getPvBTotalTurns(session.game_type);
        const emoji = getGameEmoji(session.game_type);

        let messageHTML = override.intro || '';
        messageHTML += `--- <b>Turn ${gameState.currentTurn} of ${totalTurns}</b> ---\n`;
        messageHTML += `<b>Score:</b> <span class="math-inline">\{escape\(gameState\.p1Name\)\} <b\></span>{gameState.playerScore}</b> - <b>${gameState.botScore}</b> Bot\n\n`;

        if (override.status) {
            messageHTML += `<i>${override.status}</i>`;
        } else {
            messageHTML += `It's your turn, <b>${escape(gameState.p1Name)}</b>! Send a ${emoji} **in this chat** to throw.`;
        }
        
        const oldMessageId = gameState.gameBoardMessageId;
        if (oldMessageId) {
            await bot.deleteMessage(session.chat_id, oldMessageId).catch(() => {});
        }

        const newMsg = await queuedSendMessage(session.chat_id, messageHTML, { parse_mode: 'HTML' });
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
async function handlePvBRoll(session, playerRollValue) {
    const { chat_id, game_type, game_state_json: gameState } = session;
    const emoji = getGameEmoji(game_type);

    try {
        if (gameState.gameBoardMessageId) {
            bot.deleteMessage(chat_id, gameState.gameBoardMessageId).catch(() => {});
            gameState.gameBoardMessageId = null;
        }

        console.log(`[handlePvBRoll] Player threw a ${playerRollValue}. Waiting 2s for bot.`);
        
        await sleep(2000);

        const botDiceMessage = await queuedSendDice(chat_id, { emoji });
        if (!botDiceMessage || !botDiceMessage.dice) {
            throw new Error("Failed to send bot's dice roll message.");
        }
        const botRollValue = botDiceMessage.dice.value;
        
        await sleep(2500);

        let playerResultPoints = 0;
        let botResultPoints = 0;

        if (game_type === 'bowling') {
            playerResultPoints = PVB_BOWLING_SCORES[playerRollValue] || 0;
            botResultPoints = PVB_BOWLING_SCORES[botRollValue] || 0;
        } else if (game_type === 'basketball') {
            playerResultPoints = (playerRollValue >= 4) ? 1 : 0;
            botResultPoints = (botRollValue >= 3) ? 1 : 0;
        } else if (game_type === 'darts') {
            playerResultPoints = DARTS_501_POINTS_PER_ROLL[playerRollValue] || 0;
            botResultPoints = DARTS_501_POINTS_PER_ROLL[botRollValue] || 0;
        }
        
        gameState.playerRolls.push(playerRollValue);
        gameState.botRolls.push(botRollValue);
        gameState.playerScore += playerResultPoints;
        gameState.botScore += botResultPoints;

        const totalTurns = getPvBTotalTurns(game_type);
        const isGameOver = (gameState.currentTurn >= totalTurns);
        
        if (isGameOver) {
            await finalizeGame(session, 'pvb_resolve', gameState);
        } else {
            gameState.currentTurn++;
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
            await updatePvBGameBoard(session.session_id);
        }
    } catch (error) {
        console.error(`[handlePvBRoll] Error during bot's turn: ${error.message}. Finalizing game with error state.`);
        await finalizeGame(session, 'error', gameState);
    }
}


// --- START OF NEW UNIFIED PVP GAME ENGINE ---
/**
 * Atomically updates the PvP game state for the next turn AND updates the Telegram message board.
 * This combines state management and UI updates to prevent race conditions.
 * @param {number} sessionId The database session ID of the game.
 */
async function updatePvPStateAndBoard(sessionId) {
    const logPrefix = `[UpdatePvPStateAndBoard_V2 SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        // Use a transaction to ensure all DB operations and checks are consistent
        await client.query('BEGIN');

        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') {
            console.warn(`${logPrefix} Game not found or not in progress. Aborting update.`);
            await client.query('ROLLBACK');
            if (activeTurnTimeouts.has(sessionId)) clearTimeout(activeTurnTimeouts.get(sessionId));
            return;
        }

        const session = res.rows[0];
        const gameState = session.game_state_json || {};
        const shotsPerPlayer = getShotsPerPlayer(session.game_type);

        // 1. Check if the game is over
        const p1_done = (gameState.p1Rolls || []).length >= shotsPerPlayer;
        const p2_done = (gameState.p2Rolls || []).length >= shotsPerPlayer;

        if (p1_done && p2_done) {
            await client.query('COMMIT'); // Commit before calling finalize, which starts its own transaction.
            await finalizeGame(session, 'pvp_resolve');
            return;
        }

        // 2. Determine next player and UPDATE the game state in the database
        gameState.currentPlayerTurn = !p1_done ? String(gameState.initiatorId) : String(gameState.opponentId);
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        
        // 3. Build the UI message content from the state we just saved
        const gameName = getCleanGameNameHelper(session.game_type);
        const emoji = getGameEmoji(session.game_type);
        const p1Name = escape(gameState.initiatorName || "Player 1");
        const p2Name = escape(gameState.opponentName || "Player 2");
        const p1Score = calculateFinalScore(session.game_type, gameState.p1Rolls);
        const p2Score = calculateFinalScore(session.game_type, gameState.p2Rolls);

        let messageHTML = `⚔️ <b>${escape(gameName)}</b>: ${p1Name} vs. ${p2Name} ⚔️\n\n`;
        messageHTML += `<b>${p1Name}:</b> <span class="math-inline">\{p1Score\} pts <i\>\(</span>{(gameState.p1Rolls || []).length}/${shotsPerPlayer} throws)</i>\n`;
        messageHTML += `<b>${p2Name}:</b> <span class="math-inline">\{p2Score\} pts <i\>\(</span>{(gameState.p2Rolls || []).length}/${shotsPerPlayer} throws)</i>\n\n`;
        const activePlayerName = (String(gameState.currentPlayerTurn) === String(gameState.initiatorId)) ? p1Name : p2Name;
        messageHTML += `It's your turn, <b>${activePlayerName}</b>! Send a ${emoji} to roll.`;

        // 4. Delete the old message and post the new one
        const oldMessageId = gameState.gameBoardMessageId;
        if (oldMessageId) {
            await bot.deleteMessage(session.chat_id, oldMessageId).catch(() => {});
        }
        const newMsg = await queuedSendMessage(session.chat_id, messageHTML, { parse_mode: 'HTML' });
        
        // 5. Save the new message ID to the database and COMMIT the entire transaction
        if (newMsg) {
            gameState.gameBoardMessageId = newMsg.message_id;
            await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        }
        
        await client.query('COMMIT');

        // 6. Set the player turn timeout only after everything is successfully saved and posted
        if (activeTurnTimeouts.has(sessionId)) clearTimeout(activeTurnTimeouts.get(sessionId));
        const timeoutId = setTimeout(() => handleGameTimeout(sessionId), PLAYER_ACTION_TIMEOUT);
        activeTurnTimeouts.set(sessionId, timeoutId);

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error: ${error.message}`);
    } finally {
        if (client) client.release();
    }
}
// --- END OF NEW UNIFIED PVP GAME ENGINE ---


// --- GAME ENGINE & STATE MACHINE ---
/**
 * NEW, SIMPLIFIED: Processes a game session from a notification payload.
 * It atomically claims the game and then immediately routes it to the correct logic.
 */
async function handleNewGameSession(sessionPayload) {
    const mainBotGameId = sessionPayload.main_bot_game_id;
    if (!mainBotGameId) return;

    const logPrefix = `[HandleNewGame_V3 GID:${mainBotGameId}]`;
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const claimQuery = `
            UPDATE interactive_game_sessions 
            SET status = 'in_progress', helper_bot_id = $1 
            WHERE main_bot_game_id = $2 AND status = 'pending_pickup' 
            RETURNING *`;
        const claimRes = await client.query(claimQuery, [MY_BOT_ID, mainBotGameId]);

        if (claimRes.rowCount === 0) {
            console.warn(`${logPrefix} Could not claim game. It was likely processed by another instance.`);
            await client.query('ROLLBACK');
            return;
        }

        const session = claimRes.rows[0];
        const gameState = session.game_state_json || {};
        const gameType = session.game_type;

        // Initialize game state properties
        gameState.p1Name = gameState.initiatorName || "Player 1";
        gameState.currentPlayerTurn = String(gameState.initiatorId || session.user_id);
        if (gameType.includes('_pvp')) {
            gameState.p2Name = gameState.opponentName || "Player 2";
            gameState.p1Rolls = []; gameState.p1Score = 0;
            gameState.p2Rolls = []; gameState.p2Score = 0;
        }
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        await client.query('COMMIT');

        // Now route the fully initialized and claimed session to the correct game logic
        if (gameType === 'darts_501') {
            await runDarts501Challenge(session);
        } else if (['bowling', 'basketball', 'darts'].includes(gameType)) {
            await runPvBGame(session);
        } else if (gameType.includes('_pvp')) {
            await updatePvPStateAndBoard(session.session_id); // Use the new unified function
        } else {
            console.error(`${logPrefix} Unknown game type to start: ${gameType}`);
            await finalizeGame(session, 'error');
        }
    } catch (e) { 
        if (client) await client.query('ROLLBACK'); 
        console.error(`${logPrefix} Error initializing game: ${e.message}`); 
    } finally { 
        if (client) client.release(); 
    }
}
async function handleRollSubmitted(session, lastRoll, lastRollerId) {
    const gameState = session.game_state_json || {};
    const logPrefix = `[HandleRollSubmitted_V4_Debug SID:${session.session_id}]`;

    console.log(`${logPrefix} Received roll data. Roller ID: ${lastRollerId}, Dice Value: ${lastRoll}`);
    console.log(`${logPrefix} Current game state expects turn from: ${gameState.currentPlayerTurn}`);

    if (String(gameState.currentPlayerTurn) !== String(lastRollerId)) {
        console.warn(`${logPrefix} VALIDATION FAILED. Expected turn from ${gameState.currentPlayerTurn}, but roll came from ${lastRollerId}. Ignoring.`);
        await queuedSendMessage(session.chat_id, "<i>It's not your turn to roll!</i>", { parse_mode: 'HTML' })
            .then(msg => setTimeout(() => bot.deleteMessage(session.chat_id, msg.message_id).catch(() => {}), 4000))
            .catch(()=>{});
        return;
    }
    
    console.log(`${logPrefix} Turn validation PASSED.`);

    if (activeTurnTimeouts.has(session.session_id)) {
        clearTimeout(activeTurnTimeouts.get(session.session_id));
        activeTurnTimeouts.delete(session.session_id);
    }

    if (session.game_type.includes('_pvp')) {
        const playerKey = (String(gameState.initiatorId) === gameState.currentPlayerTurn) ? 'p1' : 'p2';
        if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
        gameState[`${playerKey}Rolls`].push(lastRoll);
        
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
        
        await updatePvPStateAndBoard(session.session_id); // Use the new unified function

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
            const { playerScore, botScore } = gameState;
            if ((liveSession.game_type === 'bowling' || liveSession.game_type === 'darts') && playerScore === botScore) {
                dbStatus = 'completed_loss';
            } else if (liveSession.game_type === 'basketball' && playerScore === botScore) {
                dbStatus = 'completed_push';
            } else if (playerScore > botScore) {
                dbStatus = 'completed_win';
            } else {
                dbStatus = 'completed_loss';
            }
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
        
        if (gameState.gameBoardMessageId) {
            bot.deleteMessage(liveSession.chat_id, gameState.gameBoardMessageId).catch(() => {});
        } else if (gameState.lastMessageId) { // Fallback for Darts 501
             bot.deleteMessage(liveSession.chat_id, gameState.lastMessageId).catch(() => {});
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
async function setupHelperNotificationListener() {
    console.log("⚙️ [Helper Listener] Setting up game session and roll listener...");
    const listeningClient = await pool.connect();
    
    listeningClient.on('error', (err) => {
        console.error('[Helper Listener] Dedicated client error:', err);
        setTimeout(setupHelperNotificationListener, 5000);
    });

    listeningClient.on('notification', async (msg) => {
        const logPrefix = `[Helper Listener NOTIFY Channel: ${msg.channel}]`;
        try {
            const payload = JSON.parse(msg.payload);

            if (msg.channel === 'game_session_pickup' && payload.session) {
                await handleNewGameSession(payload.session);
            } 
            else if (msg.channel === 'interactive_roll_submitted' && payload.session_id) {
                 const sessionRes = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [payload.session_id]);
                 if (sessionRes.rowCount > 0) {
                    const session = sessionRes.rows[0];
                    const { lastRoll, lastRollerId } = session.game_state_json;
                    
                    if (lastRoll !== undefined && lastRollerId !== undefined) {
                        const gameState = session.game_state_json;
                        delete gameState.lastRoll;
                        delete gameState.lastRollerId;
                        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
                        
                        await handleRollSubmitted(session, lastRoll, lastRollerId);
                    }
                 }
            }
        } catch (e) {
            console.error(`${logPrefix} Error processing notification payload:`, e);
        }
    });

    await listeningClient.query('LISTEN game_session_pickup');
    await listeningClient.query('LISTEN interactive_roll_submitted');
    console.log("✅ [Helper Listener] Now listening for real-time game events.");
}

// --- UTILITY FUNCTIONS ---
// --- Start of REPLACEMENT for the escape() function in helper_bot.js ---

function escape(text) { 
    if (text === null || typeof text === 'undefined') return ''; 
    // New, stricter sanitization: This first removes any '<' or '>' characters from the text,
    // which prevents a user's name from creating an invalid HTML tag.
    // Then it escapes the remaining special HTML characters.
    return String(text)
        .replace(/[<>]/g, '') // <-- THIS IS THE CRITICAL FIX
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- End of REPLACEMENT ---
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
console.log('🚀 Helper Bot starting in Notification-Driven Mode...');
setupHelperNotificationListener();
console.log(`✅ Helper Bot is running and listening for real-time game events.`);
