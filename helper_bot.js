// helper_bot.js - FINAL VERSION with Instant Notifications

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import PQueue from 'p-queue';

// --- Configuration ---
const HELPER_BOT_TOKEN = process.env.HELPER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MY_BOT_ID = process.env.HELPER_BOT_ID || 'HelperBot_1';
const GAME_LOOP_INTERVAL = 2500;
const PLAYER_CHOICE_TIMEOUT = 60000;

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Game Constants ---
const THREE_POINT_PAYOUTS = [1.5, 2.2, 3.5, 5.0, 10.0, 20.0, 50.0];
const PINPOINT_BOWLING_PAYOUT_MULTIPLIER = 5.5;
const DARTS_FORTUNE_PAYOUTS = { 6: 3.5, 5: 1.5, 4: 0.5, 3: 0.2, 2: 0.1, 1: 0.0 };

// --- Database & Bot Setup ---
if (!HELPER_BOT_TOKEN || !DATABASE_URL) {
    console.error("❌ CRITICAL: HELPER_BOT_TOKEN or DATABASE_URL is missing. Helper bot cannot start.");
    process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bot = new TelegramBot(HELPER_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    console.error(`[Helper] Polling Error: ${error.code} - ${error.message}`);
});

const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1000 / 25, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));


// ===================================================================
// --- CORE HELPER BOT LOGIC ---
// ===================================================================

async function processInteractiveGames() {
    if (processInteractiveGames.isRunning) return;
    processInteractiveGames.isRunning = true;
    
    let client = null;
    try {
        client = await pool.connect();
        const pendingSessions = await client.query("SELECT * FROM interactive_game_sessions WHERE status = 'pending_pickup' ORDER BY created_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED");

        for (const session of pendingSessions.rows) {
            console.log(`[Helper] Picked up session ${session.session_id} (Type: ${session.game_type})`);
            await client.query("UPDATE interactive_game_sessions SET status = 'in_progress', helper_bot_id = $1 WHERE session_id = $2", [MY_BOT_ID, session.session_id]);
            
            switch (session.game_type) {
                case 'bowling':
                    await runPinpointBowling(session);
                    break;
                case 'darts':
                    await runDartsFortune(session);
                    break;
                case 'basketball':
                    await runThreePointShootout(session);
                    break;
                default:
                    console.error(`[Helper] Unknown game type in session ${session.session_id}: ${session.game_type}`);
                    await client.query("UPDATE interactive_game_sessions SET status = 'archived_error' WHERE session_id = $1", [session.session_id]);
            }
        }
    } catch (e) {
        console.error(`[Helper] Error in main processing loop: ${e.message}`);
    } finally {
        if (client) client.release();
        processInteractiveGames.isRunning = false;
    }
}
processInteractiveGames.isRunning = false;


async function runPinpointBowling(session) {
    // --- MESSAGE IMPROVEMENT ---
    const messageTextHTML = `🎳 <b>Pinpoint Bowling</b> 🎳\n\n` +
        `The lane is yours. <b>Predict the outcome of the roll!</b>\n\n` +
        `Choose your target pin below. You have ${PLAYER_CHOICE_TIMEOUT / 1000} seconds.`;
    // --- END OF IMPROVEMENT ---

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
            console.log(`[Helper] Bowling session ${session.session_id} timed out.`);
            if (sentMsg) await bot.deleteMessage(session.chat_id, sentMsg.message_id).catch(()=>{});
            await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
        }
    }, PLAYER_CHOICE_TIMEOUT);
}


async function runDartsFortune(session) {
    // NOTE: This game's flow is purely animated (bot.sendDice). There is no static message to improve here.
    // The visual appeal comes from the animated dart emoji itself.
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const diceMessage = await bot.sendDice(session.chat_id, { emoji: '🎯' });
        if (!diceMessage || !diceMessage.dice) throw new Error("Failed to send dice animation from Telegram API.");
        
        await sleep(4000); 
        await bot.deleteMessage(session.chat_id, diceMessage.message_id).catch(() => {});
        
        const rollValue = diceMessage.dice.value;
        const multiplier = DARTS_FORTUNE_PAYOUTS[rollValue];
        const finalPayout = (BigInt(session.bet_amount_lamports) * BigInt(Math.floor(multiplier * 100))) / 100n;
        
        await client.query("UPDATE interactive_game_sessions SET status = 'completed_win', final_payout_lamports = $1 WHERE session_id = $2", [finalPayout.toString(), session.session_id]);
        await client.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
        await client.query('COMMIT');
    } catch (e) {
        if (client) await client.query('ROLLBACK');
        console.error(`[Helper] Error running Darts Fortune game for session ${session.session_id}: ${e.message}`);
        await pool.query("UPDATE interactive_game_sessions SET status = 'archived_error' WHERE session_id = $1", [session.session_id]);
    } finally {
        if (client) client.release();
    }
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
            
            // --- MESSAGE IMPROVEMENT ---
            const messageText = `✅ <b>SWISH! That's ${gameState.successfulShots} in a row!</b>\n\n` +
                `Your multiplier is now <b>x${currentMultiplier.toFixed(2)}</b>.\n\n` +
                `Keep the streak going or cash out? (${PLAYER_CHOICE_TIMEOUT / 1000}s to decide)`;
            // --- END OF IMPROVEMENT ---

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
                await client.query('COMMIT'); // Commit before starting next step
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

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setInterval(processInteractiveGames, GAME_LOOP_INTERVAL);
