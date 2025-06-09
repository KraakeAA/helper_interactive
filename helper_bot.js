// helper_bot.js - FINAL UNIFIED VERSION v5 - ALL INTERACTIVE GAMES

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import PQueue from 'p-queue';

// --- Configuration ---
const HELPER_BOT_TOKEN = process.env.HELPER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MY_BOT_ID = process.env.HELPER_BOT_ID || 'HelperBot_1';
const GAME_LOOP_INTERVAL = 3000;
const PLAYER_ACTION_TIMEOUT = 90000; // 90 seconds for a player to make a move

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ===================================================================
// --- GAME CONSTANTS ---
// ===================================================================

// --- "Press Your Luck" PvB Games ---
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

// --- PvP Duel Games ---
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
const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1000 / 20, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));


// ===================================================================
// --- GAME ENGINE & STATE MACHINE ---
// ===================================================================

/**
 * Main entry point called when a new game session is detected.
 * It identifies the game type and routes it to the correct logic.
 */
async function handleGameStart(session) {
    const logPrefix = `[HandleStart_V5 SID:${session.session_id}]`;
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
            console.log(`${logPrefix} Session was already claimed. Aborting.`);
            await client.query('ROLLBACK');
            return;
        }
        
        const liveSession = updateRes.rows[0];
        const gameState = liveSession.game_state_json || {};
        
        const isPressYourLuck = ['bowling', 'darts', 'basketball'].includes(liveSession.game_type);
        
        if (isPressYourLuck) {
             gameState.turn = 1;
             gameState.rolls = [];
             gameState.currentMultiplier = 1.0;
        } else { // PvP Duel
            gameState.p1Rolls = [];
            gameState.p1Score = 0;
            gameState.p2Rolls = [];
            gameState.p2Score = 0;
        }
        
        gameState.p1Name = gameState.initiatorName || "Player 1";
        gameState.currentPlayerTurn = String(gameState.initiatorId || liveSession.user_id);
        gameState.currentTurnStartTime = Date.now();
        if (gameState.gameMode === 'pvp') gameState.p2Name = gameState.opponentName || "Player 2";
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await client.query('COMMIT');

        if (isPressYourLuck) {
            await runPressYourLuckGame(liveSession.session_id);
        } else {
            await advancePvPGameState(liveSession.session_id);
        }

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error initializing game: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

/**
 * Handles all "Press Your Luck" style PvB games (Bowling, Darts, Basketball).
 */
async function runPressYourLuckGame(sessionId) {
    const logPrefix = `[PressYourLuck SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;

        const session = res.rows[0];
        const gameState = session.game_state_json;
        const gameType = session.game_type;

        const { maxTurns, effects } = getPressYourLuckConfig(gameType);
        const lastRoll = gameState.lastRollValue;

        if (lastRoll && effects[lastRoll].multiplier_increase === 0.0) {
            await finalizeGame(session, 'completed_loss'); // Busted
            return;
        }

        if (gameState.turn > maxTurns) {
            await finalizeGame(session, 'completed_cashout'); // Auto-cashout after final frame
            return;
        }

        await promptPressYourLuckAction(session);

    } catch (e) {
        console.error(`${logPrefix} Error in game loop: ${e.message}`);
        await finalizeGame({session_id: sessionId}, 'error');
    } finally {
        if (client) client.release();
    }
}

/**
 * Sends the prompt message for "Press Your Luck" games.
 */
async function promptPressYourLuckAction(session) {
    const gameState = session.game_state_json;
    const gameType = session.game_type;

    if (gameState.lastMessageId) {
        await bot.deleteMessage(session.chat_id, gameState.lastMessageId).catch(() => {});
    }

    const { maxTurns, emoji } = getPressYourLuckConfig(gameType);
    const currentPayout = BigInt(session.bet_amount_lamports) * BigInt(Math.floor(gameState.currentMultiplier * 100)) / 100n;
    const cashoutDisplay = await formatBalanceForDisplay(currentPayout, 'USD');

    const message = `${gameState.p1Name}, Turn ${gameState.turn}/${maxTurns}. Send ${emoji} to play.`;
    
    const keyboard = { inline_keyboard: [] };
    if (gameState.turn > 1 && gameState.currentMultiplier > 0) {
        keyboard.inline_keyboard.push([{ text: `💰 Cash Out (${cashoutDisplay})`, callback_data: `interactive_cashout:${session.session_id}` }]);
    }

    const sentMsg = await queuedSendMessage(session.chat_id, message, { reply_markup: keyboard });
    
    if (sentMsg) {
        gameState.lastMessageId = sentMsg.message_id;
        gameState.turnTimeout = setTimeout(() => finalizeGame(session, 'completed_timeout'), PLAYER_ACTION_TIMEOUT);
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    }
}

/**
 * Main state machine for all turn-based PvP Duels.
 */
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

/**
 * Sends the prompt message for PvP duel games.
 */
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

/**
 * Simulates the bot's turn for PvB interactive games that are NOT press-your-luck.
 */
async function runBotTurn(session, gameState) {
    await queuedSendMessage(session.chat_id, `🤖 The Bot Dealer is now taking its turn...`, { parse_mode: 'HTML' });
    await sleep(2000);

    const shotsPerPlayer = getShotsPerPlayer(session.game_type);
    let botRolls = [];
    for (let i = 0; i < shotsPerPlayer; i++) {
        try {
            const diceMessage = await bot.sendDice(session.chat_id, { emoji: getGameEmoji(session.game_type) });
            if (!diceMessage || !diceMessage.dice) throw new Error("Failed to get dice value from Telegram API.");
            botRolls.push(diceMessage.dice.value);
            await sleep(4000); 
        } catch (e) {
            console.error(`[RunBotTurn] Failed to send animated dice, using internal roll. Error: ${e.message}`);
            const internalRoll = Math.floor(Math.random() * 6) + 1;
            botRolls.push(internalRoll);
            await queuedSendMessage(session.chat_id, `(Bot's internal roll ${i+1}: <b>${internalRoll}</b>)`);
            await sleep(1000);
        }
    }
    
    gameState.p2Rolls = botRolls;
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await finalizeGame(session, 'pvp_resolve'); // Use pvp_resolve to trigger score comparison
}

/**
 * Handles all incoming roll notifications from the main bot.
 */
async function handleRollSubmitted(session) {
    const logPrefix = `[HandleRoll SID:${session.session_id}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [session.session_id]);
        if (res.rowCount === 0 || !res.rows[0].status.startsWith('in_progress')) return;

        const liveSession = res.rows[0];
        const gameState = liveSession.game_state_json || {};
        const rollValue = gameState.lastRoll;
        const currentPlayerId = gameState.currentPlayerTurn;

        if (liveSession.game_type.includes('_pvp')) { // It's a PvP Duel
            const playerKey = (String(gameState.initiatorId) === currentPlayerId) ? 'p1' : 'p2';
            if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
            gameState[`${playerKey}Rolls`].push(rollValue);
            gameState.currentTurnStartTime = Date.now();
            await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
            await advancePvPGameState(liveSession.session_id);
        } else { // It's a "Press Your Luck" PvB game
            if(gameState.turnTimeout) clearTimeout(gameState.turnTimeout);
            gameState.rolls.push(rollValue);
            gameState.lastRollValue = rollValue;
            const effect = getPressYourLuckConfig(liveSession.game_type).effects[rollValue];
            gameState.currentMultiplier = (gameState.currentMultiplier || 1.0) * effect.multiplier_increase;
            gameState.turn++;
            await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
            await runPressYourLuckGame(liveSession.session_id);
        }
    } catch (e) {
        console.error(`${logPrefix} Error handling submitted roll: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}


/**
 * Finalizes any game, calculates scores/payouts, and notifies the main bot.
 */
async function finalizeGame(session, finalStatus) {
    const logPrefix = `[FinalizeGame SID:${session.session_id}]`;
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const liveSessionRes = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [session.session_id]);
        if(liveSessionRes.rowCount === 0) { await client.query('ROLLBACK'); return; }
        const liveSession = liveSessionRes.rows[0];
        const gameState = liveSession.game_state_json;
        
        let dbStatus = finalStatus;
        
        if (finalStatus === 'pvp_resolve') {
            const p1Score = calculateFinalScore(liveSession.game_type, gameState.p1Rolls);
            const p2Score = calculateFinalScore(liveSession.game_type, gameState.p2Rolls);
            gameState.p1Score = p1Score;
            gameState.p2Score = p2Score;
            if (p1Score > p2Score) dbStatus = 'completed_p1_win';
            else if (p2Score > p1Score) dbStatus = 'completed_p2_win';
            else dbStatus = 'completed_push';
        }

        await client.query(
            "UPDATE interactive_game_sessions SET status = $1, game_state_json = $2 WHERE session_id = $3",
            [dbStatus, JSON.stringify(gameState), liveSession.session_id]
        );
        await client.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: liveSession.session_id })}'`);
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


// --- Event Handlers & Main Loop ---

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (!data || !data.startsWith('interactive_cashout:')) return;

    await bot.answerCallbackQuery(callbackQuery.id, { text: "Cashing out..." }).catch(() => {});
    
    const sessionId = data.split(':')[1];
    const sessionRes = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
    if (sessionRes.rowCount > 0 && sessionRes.rows[0].status === 'in_progress') {
        const session = sessionRes.rows[0];
        if(String(session.user_id) !== String(callbackQuery.from.id)) return;
        const gameState = session.game_state_json;
        if(gameState.turnTimeout) clearTimeout(gameState.turnTimeout);
        await finalizeGame(session, 'completed_cashout');
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
            await handleRollSubmitted(session);
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


// --- Utility Functions ---

function getPressYourLuckConfig(gameType) {
    switch(gameType) {
        case 'bowling': return { maxTurns: BOWLING_FRAMES, effects: KINGPIN_ROLL_EFFECTS, emoji: '🎳' };
        case 'darts': return { maxTurns: DARTS_THROWS_TOTAL, effects: BULLSEYE_BLITZ_EFFECTS, emoji: '🎯' };
        case 'basketball': return { maxTurns: BASKETBALL_SHOTS_TOTAL, effects: DOWNTOWN_SHOOTOUT_EFFECTS, emoji: '🏀' };
        default: return { maxTurns: 1, effects: {}, emoji: '🎲' };
    }
}

function getShotsPerPlayer(gameType) {
    if (gameType.includes('bowling_duel_pvp')) return PVP_BOWLING_FRAMES;
    if (gameType.includes('basketball_clash_pvp')) return PVP_BASKETBALL_SHOTS;
    if (gameType.includes('darts_duel_pvp')) return PVP_DARTS_THROWS;
    return 1;
}

function calculateFinalScore(gameType, rolls) {
    const safeRolls = rolls || [];
    if (safeRolls.length === 0) return 0;
    if (gameType.includes('basketball')) return safeRolls.filter(r => r >= 4).length;
    return safeRolls.reduce((a, b) => a + b, 0);
}

function getCleanGameNameHelper(gameType) {
    if (!gameType) return "Game";
    const lowerCaseId = String(gameType).toLowerCase();
    if (lowerCaseId.includes('bowling_duel_pvp')) return "Bowling Duel";
    if (lowerCaseId.includes('darts_duel_pvp')) return "Darts Showdown";
    if (lowerCaseId.includes('basketball_clash_pvp')) return "3-Point Clash";
    if (lowerCaseId === 'bowling') return "Kingpin's Challenge";
    if (lowerCaseId === 'darts') return "Bullseye Blitz";
    if (lowerCaseId === 'basketball') return "Downtown Shootout";
    return "Game";
}

function getGameEmoji(gameType) {
    if (gameType.includes('bowling')) return '🎳';
    if (gameType.includes('darts')) return '🎯';
    if (gameType.includes('basketball')) return '🏀';
    return '🎲';
}

function formatRollsHelper(rolls) {
    if (!rolls || rolls.length === 0) return '...';
    return rolls.map(r => `<b>${r}</b>`).join(' ');
}


// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => {
    console.error("CRITICAL: Could not set up notification listeners.", e);
    process.exit(1);
});
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
