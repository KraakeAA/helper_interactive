// helper_bot.js - FINAL UNIFIED VERSION v2

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import PQueue from 'p-queue';

// --- Configuration ---
const HELPER_BOT_TOKEN = process.env.HELPER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MY_BOT_ID = process.env.HELPER_BOT_ID || 'HelperBot_1';
const GAME_LOOP_INTERVAL = 3000; // Poll a bit faster
const PLAYER_ACTION_TIMEOUT = 90000; // 90 seconds for a player to make a move

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Game Constants ---
// Original game constants
const THREE_POINT_PAYOUTS = [1.5, 2.2, 3.5, 5.0, 10.0, 20.0, 50.0];
const PINPOINT_BOWLING_PAYOUT_MULTIPLIER = 5.5;
const DARTS_FORTUNE_PAYOUTS = { 6: 3.5, 5: 1.5, 4: 0.5, 3: 0.2, 2: 0.1, 1: 0.0 };
// New Duel/Clash game constants
const BOWLING_DUEL_FRAMES = 3;
const BASKETBALL_CLASH_SHOTS = 5; // Making it 5 shots for a more interesting duel
const DARTS_DUEL_THROWS = 3;

// --- Database & Bot Setup ---
if (!HELPER_BOT_TOKEN || !DATABASE_URL) {
    console.error("❌ CRITICAL: HELPER_BOT_TOKEN or DATABASE_URL is missing. Helper bot cannot start.");
    process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new TelegramBot(HELPER_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => console.error(`[Helper] Polling Error: ${error.code} - ${error.message}`));

const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1000 / 20, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));


// ===================================================================
// --- UNIFIED GAME ENGINE (STATE MACHINE) ---
// This engine handles all new interactive games.
// ===================================================================

// --- Start of REPLACEMENT for handleGameStart in helper_bot.js ---

async function handleGameStart(session) {
    const logPrefix = `[HandleStart_V2 SID:${session.session_id}]`;
    console.log(`${logPrefix} Initializing new interactive game: ${session.game_type}`);
    let client = null;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // --- THIS IS THE FIX ---
        // First, officially claim the session by setting its status to 'in_progress'.
        const updateRes = await client.query(
            "UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2 AND status = 'pending_pickup' RETURNING *",
            [MY_BOT_ID, session.session_id]
        );

        // If another helper bot instance claimed it in a race condition, abort.
        if (updateRes.rowCount === 0) {
            console.log(`${logPrefix} Session was already claimed by another process. Aborting.`);
            await client.query('ROLLBACK');
            return;
        }
        
        const liveSession = updateRes.rows[0];
        const gameState = liveSession.game_state_json || {};
        
        // Initialize game state properties
        gameState.p1Rolls = [];
        gameState.p1Score = 0;
        gameState.currentPlayerTurn = String(gameState.initiatorId || liveSession.user_id);
        gameState.currentTurnStartTime = Date.now();

        if (gameState.gameMode === 'pvp') {
            gameState.p2Rolls = [];
            gameState.p2Score = 0;
        }
        
        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await client.query('COMMIT');

        // Now that state is saved, advance the game (which sends the first prompt)
        await advanceGameState(liveSession.session_id);

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`${logPrefix} Error initializing game: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

// --- End of REPLACEMENT for handleGameStart ---
/**
 * Called when the main bot notifies that a user has rolled the dice.
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
        
        if (!rollValue || !currentPlayerId) {
            console.error(`${logPrefix} Missing roll value or current player in game state.`);
            return;
        }

        const playerKey = (String(gameState.initiatorId) === currentPlayerId) ? 'p1' : 'p2';
        
        if (!gameState[`${playerKey}Rolls`]) gameState[`${playerKey}Rolls`] = [];
        gameState[`${playerKey}Rolls`].push(rollValue);
        
        // Reset timeout timestamp on valid action
        gameState.currentTurnStartTime = Date.now();

        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await advanceGameState(liveSession.session_id);

    } catch (e) {
        console.error(`${logPrefix} Error handling submitted roll: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

/**
 * The core state machine. Determines if the game is over, if it's the next player's turn, or if the bot needs to play.
 */
async function advanceGameState(sessionId) {
    const logPrefix = `[AdvanceState SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1 FOR UPDATE", [sessionId]);
        if (res.rowCount === 0 || res.rows[0].status !== 'in_progress') return;

        const session = res.rows[0];
        const gameState = session.game_state_json || {};
        const isPvP = gameState.gameMode === 'pvp';
        const gameType = session.game_type;

        const shotsPerPlayer = getShotsPerPlayer(gameType);
        
        const p1_done = (gameState.p1Rolls || []).length >= shotsPerPlayer;
        const p2_done = isPvP ? ((gameState.p2Rolls || []).length >= shotsPerPlayer) : true;
        
        if (p1_done && p2_done) {
            // Game is over for all players, finalize it.
            await finalizeGameSession(session, gameState);
            return;
        }

        if (!p1_done) {
            // Player 1's turn
            gameState.currentPlayerTurn = String(gameState.initiatorId);
        } else if (isPvP && !p2_done) {
            // Player 2's turn
            gameState.currentPlayerTurn = String(gameState.opponentId);
        } else if (!isPvP && p1_done) {
            // Player 1 is done, now it's the bot's turn
            await runBotTurn(session, gameState);
            return; // Bot turn will finalize the game
        }

        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        await promptNextPlayer(session, gameState);

    } catch (e) {
        console.error(`${logPrefix} Error advancing game state: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

/**
 * Sends the message to the group prompting the correct player for their turn.
 */
async function promptNextPlayer(session, gameState) {
    const { chat_id, game_type } = session;
    const { p1Name, p2Name, p1Rolls, p2Rolls, currentPlayerTurn, initiatorId } = gameState;
    
    const gameName = getCleanGameNameHelper(game_type);
    const emoji = getGameEmoji(game_type);
    const shotsPerPlayer = getShotsPerPlayer(game_type);
    
    const nextPlayerName = (String(currentPlayerTurn) === String(initiatorId)) ? p1Name : (p2Name || "Bot");
    const nextPlayerRolls = (String(currentPlayerTurn) === String(initiatorId)) ? p1Rolls : (p2Rolls || []);

    let scoreBoardHTML = `<b>${p1Name}:</b> ${formatRollsHelper(p1Rolls || [])}\n`;
    if(gameState.gameMode === 'pvp') {
        scoreBoardHTML += `<b>${p2Name}:</b> ${formatRollsHelper(p2Rolls || [])}`;
    }

    let messageHTML = `⚔️ <b>${gameName}</b> ⚔️\n\n` +
                      `${scoreBoardHTML}\n\n` +
                      `It's your turn, <b>${nextPlayerName}</b>! Send a ${emoji} to roll (Roll ${nextPlayerRolls.length + 1} of ${shotsPerPlayer}).`;
                      
    await queuedSendMessage(chat_id, messageHTML, { parse_mode: 'HTML' });
}

/**
 * Simulates the bot's turn for PvB interactive games.
 */
async function runBotTurn(session, gameState) {
    await queuedSendMessage(session.chat_id, `🤖 The Bot Dealer is now taking its turn...`, { parse_mode: 'HTML' });
    await sleep(2000);

    const shotsPerPlayer = getShotsPerPlayer(session.game_type);
    let botRolls = [];
    for (let i = 0; i < shotsPerPlayer; i++) {
        botRolls.push(Math.floor(Math.random() * 6) + 1);
    }
    gameState.p2Rolls = botRolls;
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await finalizeGameSession(session, gameState);
}

/**
 * Calculates final scores and updates the database to signal completion.
 */
async function finalizeGameSession(session, gameState) {
    const { game_type } = session;
    
    // Calculate final scores based on game rules
    const p1Score = calculateFinalScore(game_type, gameState.p1Rolls);
    const p2Score = calculateFinalScore(game_type, gameState.p2Rolls || []);

    gameState.p1Score = p1Score;
    gameState.p2Score = p2Score;
    
    let finalStatus;
    const betAmount = BigInt(session.bet_amount_lamports);
    
    if (p1Score > p2Score) {
        finalStatus = gameState.gameMode === 'pvp' ? 'completed_p1_win' : 'completed_win';
    } else if (p2Score > p1Score) {
        finalStatus = gameState.gameMode === 'pvp' ? 'completed_p2_win' : 'completed_loss';
    } else {
        finalStatus = 'completed_push';
    }

    await pool.query("UPDATE interactive_game_sessions SET status = $1, game_state_json = $2 WHERE session_id = $3", [finalStatus, JSON.stringify(gameState), session.session_id]);
    await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
}

// ===================================================================
// --- GAME-SPECIFIC HELPERS ---
// ===================================================================

function getShotsPerPlayer(gameType) {
    if (gameType.includes('bowling_duel')) return BOWLING_DUEL_FRAMES;
    if (gameType.includes('basketball_clash')) return BASKETBALL_CLASH_SHOTS;
    if (gameType.includes('darts_duel')) return DARTS_DUEL_THROWS;
    return 1; // Default
}

function calculateFinalScore(gameType, rolls) {
    if (gameType.includes('basketball')) {
        // In basketball, score is the count of successful shots (4, 5, or 6)
        return (rolls || []).filter(r => r >= 4).length;
    }
    // For bowling and darts, score is the sum of rolls
    return (rolls || []).reduce((a, b) => a + b, 0);
}

function getCleanGameNameHelper(gameType) {
    if (!gameType) return "Game";
    if (gameType.includes('bowling_duel')) return "Bowling Duel";
    if (gameType.includes('darts_duel')) return "Darts Showdown";
    if (gameType.includes('basketball_clash')) return "3-Point Clash";
    if (gameType === 'bowling') return "Pinpoint Bowling";
    if (gameType === 'darts') return "Darts of Fortune";
    if (gameType === 'basketball') return "3-Point Shootout";
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


// ===================================================================
// --- FALLBACK POLLER & MAIN EXECUTION ---
// ===================================================================

async function processPendingGames() {
    if (processPendingGames.isRunning) return;
    processPendingGames.isRunning = true;
    const logPrefix = '[Helper] Game Poller';
    
    let client = null;
    try {
        client = await pool.connect();
        
        // Poller now picks up ALL interactive game types that are pending
        const pendingSessions = await client.query("SELECT * FROM interactive_game_sessions WHERE status = 'pending_pickup' ORDER BY created_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED");

        for (const session of pendingSessions.rows) {
            console.log(`${logPrefix} Picked up session ${session.session_id} (Type: ${session.game_type})`);
            await client.query("UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2", [MY_BOT_ID, session.session_id]);
            
            // This notification is a fallback in case the main bot's initial notification was missed
            await client.query(`NOTIFY game_session_pickup, '${JSON.stringify({ session: session })}'`);
        }
    } catch (e) {
        console.error(`${logPrefix} Error in processing loop: ${e.message}`);
    } finally {
        if (client) client.release();
        processPendingGames.isRunning = false;
    }
}
processPendingGames.isRunning = false;

async function setupNotificationListeners() {
    console.log("⚙️ [Helper] Setting up notification listeners...");
    const listeningClient = await pool.connect();
    
    listeningClient.on('error', (err) => {
        console.error('[Helper] Listener client error:', err);
        // Implement reconnection logic if necessary
        setTimeout(setupNotificationListeners, 5000);
    });

    listeningClient.on('notification', (msg) => {
        try {
            const payload = JSON.parse(msg.payload);
            const session = payload.session || payload;
            if (!session || !session.session_id) return;

            if (msg.channel === 'game_session_pickup') {
                console.log(`[Helper] ⚡ Received pickup notification for session ${session.session_id}`);
                handleGameStart(session);
            } else if (msg.channel === 'interactive_roll_submitted') {
                console.log(`[Helper] ⚡ Received roll notification for session ${session.session_id}`);
                handleRollSubmitted(session);
            }
        } catch (e) {
            console.error('[Helper] Error processing notification payload:', e);
        }
    });

    await listeningClient.query('LISTEN game_session_pickup');
    await listeningClient.query('LISTEN interactive_roll_submitted');
    console.log("✅ [Helper] Now listening for 'game_session_pickup' and 'interactive_roll_submitted'.");
}


// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => {
    console.error("CRITICAL: Could not set up notification listeners.", e);
    process.exit(1);
});

// Fallback poller in case notifications are missed
setInterval(processPendingGames, GAME_LOOP_INTERVAL);
