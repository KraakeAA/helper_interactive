// helper_bot.js - FINAL UNIFIED VERSION v9 - All Logic & Functions Included, No Omissions

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
const PLAYER_ACTION_TIMEOUT = 90000;

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
const BASKETBALL_SHOTS_TOTAL = 5;
const DOWNTOWN_SHOOTOUT_EFFECTS = {
    6: { outcome: 'Swish! 🎯', multiplier_increase: 1.9 },
    5: { outcome: 'Swish! 🎯', multiplier_increase: 1.5 },
    4: { outcome: 'Rim In! 👍', multiplier_increase: 1.1 },
    3: { outcome: 'Rim Out 🟡', multiplier_increase: 0.7 },
    2: { outcome: 'Airball! 💥', multiplier_increase: 0.0 },
    1: { outcome: 'Airball! 💥', multiplier_increase: 0.0 }
};
const PVP_BOWLING_FRAMES = 3;
const PVP_BASKETBALL_SHOTS = 5;
const PVP_DARTS_THROWS = 3;

// --- Database & Bot Setup ---
if (!HELPER_BOT_TOKEN || !DATABASE_URL) {
    console.error("❌ CRITICAL: HELPER_BOT_TOKEN or DATABASE_URL is missing. Helper bot cannot start.");
    process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const PQueue = cjsPQueue.default ?? cjsPQueue;
const bot = new TelegramBot(HELPER_BOT_TOKEN, { polling: { params: { allowed_updates: ["message", "callback_query"] } } });
bot.on('polling_error', (error) => console.error(`[Helper] Polling Error: ${error.code} - ${error.message}`));
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1000 / 20, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));

// ===================================================================
// --- GAME ENGINE & STATE MACHINE ---
// ===================================================================

async function handleGameStart(session) {
    const logPrefix = `[HandleStart_V7 SID:${session.session_id}]`;
    console.log(`${logPrefix} Initializing game: ${session.game_type}`);
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const updateRes = await client.query(
            "UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2 AND status = 'pending_pickup' RETURNING *",
            [MY_BOT_ID, session.session_id]
        );
        if (updateRes.rowCount === 0) { await client.query('ROLLBACK'); return; }
        
        const liveSession = updateRes.rows[0];
        const gameState = liveSession.game_state_json || {};
        const gameType = liveSession.game_type;
        
        const isPressYourLuck = ['bowling', 'darts', 'basketball'].includes(gameType) && !gameType.includes('_pvp');
        const isNewPvPDuel = gameType.includes('_pvp');
        
        if (isPressYourLuck) {
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
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await client.query('COMMIT');

        if (isPressYourLuck) {
            await updateKingpinChallengeState(liveSession.session_id);
        } else if (isNewPvPDuel) {
            await advancePvPGameState(liveSession.session_id);
        } else {
            console.error(`${logPrefix} Unhandled game type for new engine: ${gameType}`);
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
    const logPrefix = `[UpdateKingpinState SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;

        const session = res.rows[0];
        const gameState = session.game_state_json;
        const rolls = gameState.rolls || [];
        const numRolls = rolls.length;
        const { maxTurns, emoji, effects } = getPressYourLuckConfig(session.game_type);

        const lastRoll = rolls[numRolls - 1];
        if (lastRoll === 1) {
            await finalizeGame(session, 'completed_loss');
            return;
        }
        if (numRolls >= maxTurns) {
            await finalizeGame(session, 'completed_cashout');
            return;
        }

        const betDisplay = await formatBalanceForDisplay(session.bet_amount_lamports, 'USD');
        let messageHTML = `<b>🎳 Kingpin's Challenge 🎳</b>\n\n` +
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
        let sentMsg;
        if (gameState.lastMessageId) {
            sentMsg = await bot.editMessageText(messageHTML, { chat_id: session.chat_id, message_id: gameState.lastMessageId, ...messageOptions }).catch(() => null);
            if (!sentMsg) sentMsg = await queuedSendMessage(session.chat_id, messageHTML, messageOptions);
        } else {
            sentMsg = await queuedSendMessage(session.chat_id, messageHTML, messageOptions);
        }
        
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
        
        gameState.currentTurnStartTime = Date.now();
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

    let messageHTML = `⚔️ <b>${gameName}</b> ⚔️\n\n` +
                      `${scoreBoardHTML}\n\n` +
                      `It's your turn, <b>${nextPlayerName}</b>! Send a ${emoji} to roll (Roll ${nextPlayerRolls.length + 1} of ${shotsPerPlayer}).`;
                      
    await queuedSendMessage(chat_id, messageHTML, { parse_mode: 'HTML' });
}

async function handleRollSubmitted(session, lastRoll) {
    const logPrefix = `[HandleRoll SID:${session.session_id}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [session.session_id]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;

        const liveSession = res.rows[0];
        const gameState = liveSession.game_state_json || {};
        const rollValue = lastRoll;
        const currentPlayerId = gameState.currentPlayerTurn;

        const timeoutId = activeTurnTimeouts.get(liveSession.session_id);
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeTurnTimeouts.delete(liveSession.session_id);
        }

        if (liveSession.game_type.includes('_pvp')) {
            const playerKey = (String(gameState.initiatorId) === currentPlayerId) ? 'p1' : 'p2';
            if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
            gameState[`${playerKey}Rolls`].push(rollValue);
            await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
            await advancePvPGameState(liveSession.session_id);
        } else {
            gameState.rolls.push(rollValue);
            gameState.lastRollValue = rollValue;
            const effect = getPressYourLuckConfig(liveSession.game_type).effects[rollValue];
            gameState.currentMultiplier = (gameState.currentMultiplier || 1.0) * effect.multiplier_increase;
            await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
            await updateKingpinChallengeState(liveSession.session_id);
        }
    } catch (e) {
        console.error(`${logPrefix} Error handling submitted roll: ${e.message}`);
    } finally {
        if (client) client.release();
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
        
        if (finalStatus === 'pvp_resolve') {
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

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (data && data.startsWith('interactive_cashout:')) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Cashing out..." }).catch(() => {});
        const sessionId = data.split(':')[1];
        const res = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount > 0 && res.rows[0].status === 'in_progress') {
            const session = res.rows[0];
            if(String(session.user_id) !== String(callbackQuery.from.id)) return;
            await finalizeGame(session, 'completed_cashout');
        }
        return;
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
        if (!session || !session.session_id) return;

        if (msg.channel === 'game_session_pickup') {
            await handleGameStart(session);
        } else if (msg.channel === 'interactive_roll_submitted') {
            const res = await pool.query("SELECT game_state_json FROM interactive_game_sessions WHERE session_id = $1", [session.session_id]);
            if (res.rows.length > 0) {
                 const { lastRoll } = res.rows[0].game_state_json;
                 await handleRollSubmitted(session, lastRoll);
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

// --- UTILITY FUNCTIONS ---

function escape(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function stringifyWithBigInt(obj) { return JSON.stringify(obj, (key, value) => (typeof value === 'bigint' ? value.toString() + 'n' : value), 2); }
async function fetchSolUsdPriceFromBinanceAPI() { try { const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 8000 }); if (response.data?.price) return parseFloat(response.data.price); throw new Error('Invalid price data from Binance API.'); } catch (error) { throw error; }}
async function fetchSolUsdPriceFromCoinGeckoAPI() { try { const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 8000 }); if (response.data?.solana?.usd) return parseFloat(response.data.solana.usd); throw new Error('Invalid price data from CoinGecko API.'); } catch (error) { throw error; }}
async function getSolUsdPrice() { const cached = solPriceCache.get(SOL_PRICE_CACHE_KEY); if (cached && (Date.now() - cached.timestamp < SOL_USD_PRICE_CACHE_TTL_MS)) return cached.price; try { const price = await fetchSolUsdPriceFromBinanceAPI(); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e) { try { const price = await fetchSolUsdPriceFromCoinGeckoAPI(); solPriceCache.set(SOL_PRICE_CACHE_KEY, { price, timestamp: Date.now() }); return price; } catch (e2) { if (cached) return cached.price; throw new Error("Could not retrieve SOL/USD price from any source."); } }}
function convertLamportsToUSDString(lamports, solUsdPrice, d = 2) { if (typeof solUsdPrice !== 'number' || solUsdPrice <= 0) return 'N/A'; const sol = Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL); return `$${(sol * solUsdPrice).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;}
async function formatBalanceForDisplay(lamports, currency = 'USD') { if (currency === 'USD') { try { const price = await getSolUsdPrice(); return convertLamportsToUSDString(lamports, price); } catch (e) { return 'N/A'; } } return `${(Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL)).toFixed(SOL_DECIMALS)} SOL`;}
function getPressYourLuckConfig(gameType) { switch(gameType) { case 'bowling': return { maxTurns: BOWLING_FRAMES, effects: KINGPIN_ROLL_EFFECTS, emoji: '🎳' }; case 'darts': return { maxTurns: DARTS_THROWS_TOTAL, effects: BULLSEYE_BLITZ_EFFECTS, emoji: '🎯' }; case 'basketball': return { maxTurns: BASKETBALL_SHOTS_TOTAL, effects: DOWNTOWN_SHOOTOUT_EFFECTS, emoji: '🏀' }; default: return { maxTurns: 1, effects: {}, emoji: '🎲' }; }}
function getShotsPerPlayer(gameType) { const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return PVP_BOWLING_FRAMES; if (lt.includes('basketball_clash_pvp')) return PVP_BASKETBALL_SHOTS; if (lt.includes('darts_duel_pvp')) return PVP_DARTS_THROWS; return 1; }
function calculateFinalScore(gameType, rolls) { const safeRolls = rolls || []; if (safeRolls.length === 0) return 0; if (gameType.includes('basketball')) return safeRolls.filter(r => r >= 4).length; return safeRolls.reduce((a, b) => a + b, 0); }
function getCleanGameNameHelper(gameType) { if (!gameType) return "Game"; const lt = String(gameType).toLowerCase(); if (lt.includes('bowling_duel_pvp')) return "Bowling Duel"; if (lt.includes('darts_duel_pvp')) return "Darts Showdown"; if (lt.includes('basketball_clash_pvp')) return "3-Point Clash"; if (lt === 'bowling') return "Kingpin's Challenge"; if (lt === 'darts') return "Bullseye Blitz"; if (lt === 'basketball') return "Downtown Shootout"; return "Game"; }
function getGameEmoji(gameType) { if (gameType.includes('bowling')) return '🎳'; if (gameType.includes('darts')) return '🎯'; if (gameType.includes('basketball')) return '🏀'; return '🎲'; }
function formatRollsHelper(rolls) { if (!rolls || rolls.length === 0) return '...'; return rolls.map(r => `<b>${r}</b>`).join(' '); }

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => {
    console.error("CRITICAL: Could not set up notification listeners.", e);
    process.exit(1);
});
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
