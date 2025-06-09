// helper_bot.js - FINAL VERSION with Crash Fix and All Game Logic

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import PQueue from 'p-queue';

// --- Configuration ---
const HELPER_BOT_TOKEN = process.env.HELPER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MY_BOT_ID = process.env.HELPER_BOT_ID || 'HelperBot_1';
const GAME_LOOP_INTERVAL = 5000;
const PLAYER_CHOICE_TIMEOUT = 60000;

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Game Constants ---
const THREE_POINT_PAYOUTS = [1.5, 2.2, 3.5, 5.0, 10.0, 20.0, 50.0];
const PINPOINT_BOWLING_PAYOUT_MULTIPLIER = 5.5;
const DARTS_FORTUNE_PAYOUTS = { 6: 3.5, 5: 1.5, 4: 0.5, 3: 0.2, 2: 0.1, 1: 0.0 };
const BOWLING_FRAMES = 3;
const BASKETBALL_SHOTS = 3;
const DARTS_THROWS = 1;

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
// --- NEW TURN-BASED GAME ENGINE ---
// ===================================================================

async function handleGameStart(session) {
    const logPrefix = `[HandleStart SID:${session.session_id}]`;
    console.log(`${logPrefix} Initializing new interactive game.`);
    const gameState = session.game_state_json || {};
    
    gameState.p1Rolls = [];
    gameState.p1Score = 0;
    gameState.currentPlayerTurn = gameState.initiatorId || session.user_id;

    if (gameState.gameMode === 'pvp') {
        gameState.p2Rolls = [];
        gameState.p2Score = 0;
    }
    
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await advanceGameState(session.session_id);
}

async function handleRollSubmitted(session) {
    const logPrefix = `[HandleRoll SID:${session.session_id}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [session.session_id]);
        if (res.rowCount === 0 || !res.rows[0].status.startsWith('in_progress')) return;

        const liveSession = res.rows[0];
        const gameState = liveSession.game_state_json || {};
        const rollValue = gameState.lastRoll;
        const currentPlayerId = gameState.currentPlayerTurn;
        
        if (!rollValue || !currentPlayerId) {
            console.error(`${logPrefix} Missing roll value or current player in game state.`);
            return;
        }

        const playerKey = (gameState.initiatorId === currentPlayerId) ? 'p1' : 'p2';
        
        if (gameState[`${playerKey}Rolls`]) {
            gameState[`${playerKey}Rolls`].push(rollValue);
        } else {
            gameState[`${playerKey}Rolls`] = [rollValue];
        }

        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), liveSession.session_id]);
        await advanceGameState(liveSession.session_id);

    } catch (e) {
        console.error(`${logPrefix} Error handling submitted roll: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

async function advanceGameState(sessionId) {
    const logPrefix = `[AdvanceState SID:${sessionId}]`;
    let client = null;
    try {
        client = await pool.connect();
        const res = await client.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (res.rowCount === 0) return;

        const session = res.rows[0];
        if (session.status !== 'in_progress') return;

        const gameState = session.game_state_json || {};
        const isPvP = gameState.gameMode === 'pvp';
        const gameType = session.game_type;

        const shotsPerPlayer = gameType.includes('bowling_duel') ? BOWLING_FRAMES : gameType.includes('basketball_clash') ? BASKETBALL_SHOTS : DARTS_THROWS;

        const p1_done = gameState.p1Rolls.length >= shotsPerPlayer;
        const p2_done = isPvP ? (gameState.p2Rolls.length >= shotsPerPlayer) : true;
        
        if (p1_done && p2_done) {
            await finalizeGameSession(session, gameState);
            return;
        }

        if (!p1_done) {
            gameState.currentPlayerTurn = gameState.initiatorId;
        } else if (isPvP && !p2_done) {
            gameState.currentPlayerTurn = gameState.opponentId;
        } else if (!isPvP && p1_done) { 
            await runBotTurn(session, gameState);
            return;
        }

        await client.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        await promptNextPlayer(session, gameState);

    } catch (e) {
        console.error(`${logPrefix} Error advancing game state: ${e.message}`);
    } finally {
        if (client) client.release();
    }
}

async function promptNextPlayer(session, gameState) {
    const { chat_id, game_type } = session;
    const { p1Name, p2Name, p1Rolls, p2Rolls, currentPlayerTurn, initiatorId } = gameState;
    
    const gameName = getCleanGameNameHelper(game_type);
    const emoji = getGameEmoji(game_type);
    const shotsPerPlayer = game_type.includes('bowling_duel') ? BOWLING_FRAMES : game_type.includes('basketball_clash') ? BASKETBALL_SHOTS : DARTS_THROWS;
    
    const nextPlayerName = (currentPlayerTurn === initiatorId) ? p1Name : (p2Name || "Bot");
    const nextPlayerRolls = (currentPlayerTurn === initiatorId) ? p1Rolls : (p2Rolls || []);

    let messageHTML = `⚔️ <b>${gameName}</b> ⚔️\n\n` +
                      `<b>${p1Name}:</b> ${formatRollsHelper(p1Rolls)}\n` +
                      `<b>${p2Name || 'Bot'}:</b> ${formatRollsHelper(p2Rolls || [])}\n\n` +
                      `It's your turn, <b>${nextPlayerName}</b>! Send a ${emoji} to roll (Roll ${nextPlayerRolls.length + 1} of ${shotsPerPlayer}).`;
                      
    await queuedSendMessage(chat_id, messageHTML, { parse_mode: 'HTML' });
}

async function runBotTurn(session, gameState) {
    const shotsPerPlayer = session.game_type.includes('bowling_duel') ? BOWLING_FRAMES : 1;
    let botRolls = [];
    for (let i = 0; i < shotsPerPlayer; i++) {
        botRolls.push(Math.floor(Math.random() * 6) + 1);
    }
    gameState.p2Rolls = botRolls;
    await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), session.session_id]);
    await finalizeGameSession(session, gameState);
}

async function finalizeGameSession(session, gameState) {
    const { game_type } = session;
    const isBasketball = game_type.includes('basketball');
    
    const p1Score = isBasketball ? gameState.p1Rolls.filter(r => r >= 4).length : gameState.p1Rolls.reduce((a, b) => a + b, 0);
    const p2Score = isBasketball ? (gameState.p2Rolls || []).filter(r => r >= 4).length : (gameState.p2Rolls || []).reduce((a, b) => a + b, 0);

    gameState.p1Score = p1Score;
    gameState.p2Score = p2Score;
    
    let finalStatus;
    let finalPayout = 0n;
    const betAmount = BigInt(session.bet_amount_lamports);
    
    if (p1Score > p2Score) {
        finalStatus = gameState.gameMode === 'pvp' ? 'completed_p1_win' : 'completed_win';
        finalPayout = betAmount * 2n;
    } else if (p2Score > p1Score) {
        finalStatus = gameState.gameMode === 'pvp' ? 'completed_p2_win' : 'completed_loss';
        finalPayout = 0n;
    } else {
        finalStatus = 'completed_push';
        finalPayout = betAmount;
    }

    await pool.query("UPDATE interactive_game_sessions SET status = $1, final_payout_lamports = $2, game_state_json = $3 WHERE session_id = $4", [finalStatus, finalPayout.toString(), JSON.stringify(gameState), session.session_id]);
    await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
}

// --- ORIGINAL PVB GAME LOGIC (PRESERVED) ---

async function runOriginalPinpointBowling(session) {
    const messageTextHTML = `🎳 <b>Pinpoint Bowling Challenge!</b> 🎳\n\n` +
        `<b>Predict the exact outcome of the roll!</b> Choose your target below. You have ${PLAYER_CHOICE_TIMEOUT / 1000} seconds.`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "Gutter (1)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:1` }, { text: "Hit (2)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:2` }, { text: "Hit (3)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:3` }],
            [{ text: "Hit (4)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:4` }, { text: "Hit (5)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:5` }, { text: "Strike! (6)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:6` }]
        ]
    };
    
    const sentMsg = await queuedSendMessage(session.chat_id, messageTextHTML, { parse_mode: 'HTML', reply_markup: keyboard });
    
    setTimeout(async () => {
        const res = await pool.query("UPDATE interactive_game_sessions SET status = 'completed_timeout' WHERE session_id = $1 AND status = 'in_progress' RETURNING session_id", [session.session_id]);
        if (res.rowCount > 0) {
            console.log(`[Helper] Original Bowling session ${session.session_id} timed out.`);
            if (sentMsg) await bot.deleteMessage(session.chat_id, sentMsg.message_id).catch(()=>{});
            await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
        }
    }, PLAYER_CHOICE_TIMEOUT);
}

async function runDartsFortune(session) {
    const diceMessage = await bot.sendDice(session.chat_id, { emoji: '🎯' });
    if (!diceMessage || !diceMessage.dice) throw new Error("Failed to send dice animation from Telegram API.");
    
    await sleep(4000); 
    await bot.deleteMessage(session.chat_id, diceMessage.message_id).catch(() => {});
    
    const rollValue = diceMessage.dice.value;
    const multiplier = DARTS_FORTUNE_PAYOUTS[rollValue];
    const finalPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(multiplier * 100))) / 100n;
    
    await pool.query("UPDATE interactive_game_sessions SET status = 'completed_win', final_payout_lamports = $1 WHERE session_id = $2", [finalPayout.toString(), session.session_id]);
    await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
}

async function runThreePointShootout(session) {
    await processThreePointShot(session.session_id);
}

async function processThreePointShot(sessionId) {
    const logPrefix = `[Helper_3PT GID:${sessionId}]`;
    let gameData, processingMsg;
    try {
        const gameRes = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
        if (gameRes.rowCount === 0 || gameRes.rows[0].status !== 'in_progress') return;
        
        gameData = gameRes.rows[0];
        const gameState = gameData.game_state_json || {};
        
        processingMsg = await queuedSendMessage(gameData.chat_id, `🏀 Taking shot #${(gameState.successfulShots || 0) + 1}...`, { parse_mode: 'HTML' });
        const diceMessage = await bot.sendDice(gameData.chat_id, { emoji: '🏀' });

        if (!diceMessage || !diceMessage.dice) throw new Error("Failed to send dice animation, likely due to API or network issue.");

        await sleep(3000);
        if (processingMsg) await bot.deleteMessage(gameData.chat_id, processingMsg.message_id).catch(() => {});
        await bot.deleteMessage(gameData.chat_id, diceMessage.message_id).catch(() => {});

        const rollValue = diceMessage.dice.value;

        if (rollValue >= 4) { // MAKE!
            gameState.successfulShots = (gameState.successfulShots || 0) + 1;
            const currentMultiplier = THREE_POINT_PAYOUTS[gameState.successfulShots - 1] || THREE_POINT_PAYOUTS[THREE_POINT_PAYOUTS.length - 1];
            gameState.currentMultiplier = currentMultiplier;
            
            await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
            
            const messageText = `✅ <b>SWISH! ${gameState.successfulShots} in a row!</b>\n\n` +
                `Your multiplier is now <b>x${currentMultiplier.toFixed(2)}</b>.\n\n` +
                `Keep the streak going or take the win? (${PLAYER_CHOICE_TIMEOUT / 1000}s to decide)`;

            const keyboard = { inline_keyboard: [[{ text: `🏀 Shoot Again!`, callback_data: `h:3pt_shoot:${gameData.main_bot_game_id}` }, { text: `💰 Cash Out`, callback_data: `h:3pt_cashout:${gameData.main_bot_game_id}` }]] };
            const sentMsg = await queuedSendMessage(gameData.chat_id, messageText, { parse_mode: 'HTML', reply_markup: keyboard });
            
            setTimeout(async () => {
                const payout = (BigInt(gameData.bet_amount_lamports) * BigInt(Math.floor(currentMultiplier * 100))) / 100n;
                const res = await pool.query("UPDATE interactive_game_sessions SET status = 'completed_cashout_timeout', final_payout_lamports = $1 WHERE session_id = $2 AND status = 'in_progress'", [payout.toString(), sessionId]);
                if (res.rowCount > 0) {
                    if (sentMsg) await bot.deleteMessage(gameData.chat_id, sentMsg.message_id).catch(() => {});
                    await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: sessionId })}'`);
                }
            }, PLAYER_CHOICE_TIMEOUT);

        } else { // MISS
            await pool.query("UPDATE interactive_game_sessions SET status = 'completed_miss', final_payout_lamports = 0 WHERE session_id = $1", [sessionId]);
            await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: sessionId })}'`);
        }
    } catch (e) {
        console.error(`${logPrefix} Error processing shot, marking as error: ${e.message}`);
        if (processingMsg) await bot.deleteMessage(gameData.chat_id, processingMsg.message_id).catch(() => {});
        await pool.query("UPDATE interactive_game_sessions SET status = 'archived_error' WHERE session_id = $1", [sessionId]);
    }
}

// --- LISTENERS (Callbacks & Database Notifications) ---

bot.on('callback_query', async (callbackQuery) => {
    await bot.answerCallbackQuery(callbackQuery.id).catch(()=>{});
    const data = callbackQuery.data;
    if (!data || !data.startsWith('h:')) return; 

    const [prefix, action, gameId, choice] = data.split(':');
    
    const sessionRes = await pool.query("SELECT * FROM interactive_game_sessions WHERE main_bot_game_id = $1 AND status = 'in_progress'", [gameId]);
    if (sessionRes.rowCount === 0) return;
    const session = sessionRes.rows[0];

    if (String(session.user_id) !== String(callbackQuery.from.id)) return;

    await bot.deleteMessage(callbackQuery.message.chat.id, callbackQuery.message.message_id).catch(() => {});
    
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        let finalStatus = '';
        let finalPayout = 0n;

        switch (action) {
            case 'bowling_choice':
                const diceMessage = await bot.sendDice(session.chat_id, { emoji: '🎳' });
                await sleep(4000);
                if (diceMessage) await bot.deleteMessage(session.chat_id, diceMessage.message_id).catch(()=>{});
                
                const rollValue = diceMessage ? diceMessage.dice.value : 1;
                const win = (String(choice) === String(rollValue));
                
                finalStatus = win ? 'completed_win' : 'completed_loss';
                if (win) {
                    finalPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(PINPOINT_BOWLING_PAYOUT_MULTIPLIER * 100))) / 100n;
                }
                break;
            
            case '3pt_shoot':
                await client.query('COMMIT'); 
                await processThreePointShot(session.session_id);
                return; 

            case '3pt_cashout':
                const gameState = session.game_state_json || {};
                const currentMultiplier = gameState.currentMultiplier || 0;
                finalPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(currentMultiplier * 100))) / 100n;
                finalStatus = currentMultiplier > 0 ? 'completed_cashout' : 'completed_loss';
                break;
        }

        if (finalStatus) {
            await client.query("UPDATE interactive_game_sessions SET status = $1, final_payout_lamports = $2 WHERE session_id = $3", [finalStatus, finalPayout.toString(), session.session_id]);
            await client.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
        }
        
        await client.query('COMMIT');

    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`[Helper] Error in callback handler for action ${action}: ${e.message}`);
        await pool.query("UPDATE interactive_game_sessions SET status = 'archived_error' WHERE session_id = $1", [session.session_id]);
    } finally {
        if (client) client.release();
    }
});

async function setupNotificationListeners() {
    console.log("⚙️ [Helper] Setting up notification listeners...");
    const listeningClient = await pool.connect();
    
    listeningClient.on('error', (err) => {
        console.error('[Helper] Listener client error:', err);
        setTimeout(setupNotificationListeners, 5000);
    });

    listeningClient.on('notification', (msg) => {
        try {
            const payload = JSON.parse(msg.payload);
            const session = payload.session || payload; // Adapt to different payload structures
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
    console.log("✅ [Helper] Now listening for 'game_session_pickup' and 'interactive_roll_submitted' notifications.");
}


// --- Utility Functions for Helper ---
function getCleanGameNameHelper(gameType) {
    if (!gameType) return "Game";
    const lowerCaseId = String(gameType).toLowerCase();
    if (lowerCaseId.includes('bowling_duel')) return "Bowling Duel";
    if (lowerCaseId.includes('darts_duel')) return "Darts Showdown";
    if (lowerCaseId.includes('basketball_clash')) return "3-Point Clash";
    if (lowerCaseId === 'bowling') return "Pinpoint Bowling";
    if (lowerCaseId === 'darts') return "Darts of Fortune";
    if (lowerCaseId === 'basketball') return "3-Point Shootout";
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

// --- THIS IS THE CORRECTED FALLBACK POLLER ---
async function processInteractiveGames() {
    if (processInteractiveGames.isRunning) return;
    processInteractiveGames.isRunning = true;
    const logPrefix = '[Helper] Fallback Poller';
    
    let client = null;
    try {
        client = await pool.connect();
        // This poller now only looks for the ORIGINAL game types
        const pendingSessions = await client.query("SELECT * FROM interactive_game_sessions WHERE status = 'pending_pickup' AND game_type IN ('bowling', 'darts', 'basketball') ORDER BY created_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED");

        for (const session of pendingSessions.rows) {
            console.log(`${logPrefix} Picked up original game session ${session.session_id} (Type: ${session.game_type})`);
            await client.query("UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2", [MY_BOT_ID, session.session_id]);
            
            switch (session.game_type) {
                case 'bowling': await runOriginalPinpointBowling(session); break;
                case 'darts': await runDartsFortune(session); break;
                case 'basketball': await runThreePointShootout(session); break;
            }
        }
    } catch (e) {
        console.error(`${logPrefix} Error in fallback processing loop: ${e.message}`);
    } finally {
        if (client) client.release();
        processInteractiveGames.isRunning = false;
    }
}
// This line is crucial for the poller's isRunning check
processInteractiveGames.isRunning = false;


// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setupNotificationListeners().catch(e => {
    console.error("CRITICAL: Could not set up notification listeners.", e);
    process.exit(1);
});

// The fallback poller for original games
setInterval(processInteractiveGames, GAME_LOOP_INTERVAL);
