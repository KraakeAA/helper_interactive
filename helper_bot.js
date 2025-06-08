// helper_bot.js - Handles API-intensive game interactions

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';
import PQueue from 'p-queue';

// --- Configuration ---
const HELPER_BOT_TOKEN = process.env.HELPER_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MY_BOT_ID = process.env.HELPER_BOT_ID || 'HelperBot_1'; // An identifier for this helper instance

// --- Basic Utilities ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function escapeHTML(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// --- Game Constants ---
const THREE_POINT_PAYOUTS = [1.5, 2.2, 3.5, 5.0, 10.0, 20.0, 50.0];
const PINPOINT_BOWLING_PAYOUT_MULTIPLIER = 5.5;
const HOUSE_FEE_PERCENT = 0.01;

// --- Database & Bot Setup ---
if (!HELPER_BOT_TOKEN || !DATABASE_URL) {
    console.error("❌ CRITICAL: HELPER_BOT_TOKEN or DATABASE_URL is missing in .env file. Helper bot cannot start.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
const bot = new TelegramBot(HELPER_BOT_TOKEN, { polling: true });

const telegramSendQueue = new PQueue({ concurrency: 1, interval: 1000 / 25, intervalCap: 1 });
const queuedSendMessage = (...args) => telegramSendQueue.add(() => bot.sendMessage(...args));
const queuedEditMessageText = (...args) => telegramSendQueue.add(() => bot.editMessageText(...args));

// ===================================================================
// --- CORE HELPER BOT LOGIC ---
// ===================================================================

/**
 * Main polling function for the helper bot. Finds and processes new game sessions.
 */
// REPLACEMENT for processInteractiveGames in helper_bot.js

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
            
            // *** THIS IS THE FIX: The cases now match the GAME_IDS from the Main Bot ***
            switch (session.game_type) {
                case 'bowling': // Changed from 'bowling_pinpoint'
                    await runPinpointBowling(session);
                    break;
                case 'basketball': // Changed from '3pt_shootout'
                    await runThreePointShootout(session);
                    break;
                default:
                    console.error(`[Helper] Unknown game type in session ${session.session_id}: ${session.game_type}`);
                    await client.query("UPDATE interactive_game_sessions SET status = 'archived_error', final_payout_lamports = $1 WHERE session_id = $2", [session.bet_amount_lamports, session.session_id]);
            }
        }
    } catch (e) {
        console.error(`[Helper] Error in main processing loop: ${e.message}`);
    } finally {
        if (client) client.release();
        processInteractiveGames.isRunning = false;
    }
}
/**
 * Sends the initial message for a Pinpoint Bowling game.
 */
async function runPinpointBowling(session) {
    const messageTextHTML = `🎳 <b>Pinpoint Bowling Challenge!</b> 🎳\n\n` +
        `Your bet is locked in. Our Game Bot is now handling the action.\n\n` +
        `<b>Predict the exact outcome of the roll!</b> Choose your target below. You have 60 seconds.`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "Gutter (1)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:1` }, { text: "Hit (2)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:2` }, { text: "Hit (3)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:3` }],
            [{ text: "Hit (4)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:4` }, { text: "Hit (5)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:5` }, { text: "Strike! (6)", callback_data: `h:bowling_choice:${session.main_bot_game_id}:6` }]
        ]
    };
    
    const sentMsg = await queuedSendMessage(session.chat_id, messageTextHTML, { parse_mode: 'HTML', reply_markup: keyboard });
    
    // Set a timeout to forfeit the game if no choice is made
    setTimeout(async () => {
        const res = await pool.query("UPDATE interactive_game_sessions SET status = 'completed_timeout' WHERE session_id = $1 AND status = 'in_progress' RETURNING session_id", [session.session_id]);
        if (res.rowCount > 0) {
            console.log(`[Helper] Bowling session ${session.session_id} timed out.`);
            if (sentMsg) await bot.deleteMessage(session.chat_id, sentMsg.message_id).catch(()=>{});
            await queuedSendMessage(session.chat_id, `⏱️ Your Pinpoint Bowling game timed out and the bet was forfeited.`, { parse_mode: 'HTML' });
        }
    }, 60000);
}

/**
 * Starts the 3-Point Shootout game by taking the first shot.
 */
async function runThreePointShootout(session) {
    await processThreePointShot(session.session_id);
}

/**
 * Processes a single shot in the 3-Point Shootout game.
 */
async function processThreePointShot(sessionId) {
    const logPrefix = `[Helper_3PT GID:${sessionId}]`;
    const gameRes = await pool.query("SELECT * FROM interactive_game_sessions WHERE session_id = $1", [sessionId]);
    if (gameRes.rowCount === 0 || gameRes.rows[0].status !== 'in_progress') {
        console.log(`${logPrefix} Game is no longer in progress. Aborting shot.`);
        return;
    }
    const gameData = gameRes.rows[0];
    // *** THIS IS THE FIX: The database returns an object, not a string. No need to parse. ***
    const gameState = gameData.game_state_json || {};
    
    const processingMsg = await queuedSendMessage(gameData.chat_id, `🏀 Taking shot #${(gameState.successfulShots || 0) + 1}...`, { parse_mode: 'HTML' });
    
    const diceMessage = await bot.sendDice(gameData.chat_id, { emoji: '🏀' });
    const rollValue = diceMessage.dice.value;
    await sleep(3000);

    if (processingMsg) await bot.deleteMessage(gameData.chat_id, processingMsg.message_id).catch(() => {});
    await bot.deleteMessage(gameData.chat_id, diceMessage.message_id).catch(() => {});

    if (rollValue >= 4) { // It's a MAKE!
        gameState.successfulShots = (gameState.successfulShots || 0) + 1;
        const currentMultiplier = THREE_POINT_PAYOUTS[gameState.successfulShots - 1] || THREE_POINT_PAYOUTS[THREE_POINT_PAYOUTS.length - 1];
        gameState.currentMultiplier = currentMultiplier; // Store multiplier for cashout logic
        
        await pool.query("UPDATE interactive_game_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(gameState), sessionId]);
        
        const messageText = `✅ **SWISH!** That's <b>${gameState.successfulShots} in a row!</b>\n\n` +
            `Current Multiplier: <b>x${currentMultiplier.toFixed(2)}</b>\n\n` +
            `What's the next move? (60s to decide)`;

        const keyboard = { inline_keyboard: [[{ text: `🏀 Shoot Again!`, callback_data: `h:3pt_shoot:${gameData.main_bot_game_id}` }, { text: `💰 Cash Out`, callback_data: `h:3pt_cashout:${gameData.main_bot_game_id}` }]] };
        const sentMsg = await queuedSendMessage(gameData.chat_id, messageText, { parse_mode: 'HTML', reply_markup: keyboard });
        
        // Set a timeout that will automatically cash the user out if they don't respond
        setTimeout(async () => {
            const payout = BigInt(gameData.bet_amount_lamports) * BigInt(Math.floor(currentMultiplier * 100)) / 100n;
            const res = await pool.query("UPDATE interactive_game_sessions SET status = 'completed_cashout_timeout', final_payout_lamports = $1 WHERE session_id = $2 AND status = 'in_progress'", [payout.toString(), sessionId]);
            if (res.rowCount > 0) {
                 if (sentMsg) await bot.deleteMessage(gameData.chat_id, sentMsg.message_id).catch(() => {});
                 await queuedSendMessage(gameData.chat_id, `⏱️ Your 3-Point Shootout game timed out and was automatically cashed out at <b>x${currentMultiplier.toFixed(2)}</b>!`, { parse_mode: 'HTML'});
            }
        }, 60000);

    } else { // It's a MISS
        await pool.query("UPDATE interactive_game_sessions SET status = 'completed_miss', final_payout_lamports = 0 WHERE session_id = $1", [sessionId]);
        await queuedSendMessage(gameData.chat_id, `💔 **CLANK!** You missed after making ${gameState.successfulShots || 0} shots in a row.`, { parse_mode: 'HTML' });
    }
}

// --- Callback Query Router for Helper Bot ---
bot.on('callback_query', async (callbackQuery) => {
    await bot.answerCallbackQuery(callbackQuery.id).catch(()=>{});
    const data = callbackQuery.data;
    if (!data || !data.startsWith('h:')) return; // Only handle callbacks prefixed for the Helper

    const [prefix, action, gameId, choice] = data.split(':');
    
    const sessionRes = await pool.query("SELECT * FROM interactive_game_sessions WHERE main_bot_game_id = $1 AND status = 'in_progress'", [gameId]);
    if (sessionRes.rowCount === 0) return;
    const session = sessionRes.rows[0];

    if (String(session.user_id) !== String(callbackQuery.from.id)) return;

    await bot.deleteMessage(callbackQuery.message.chat.id, callbackQuery.message.message_id).catch(() => {});

    switch (action) {
        case 'bowling_choice':
            await bot.sendMessage(session.chat_id, `You chose ${choice}. Rolling...`);
            const diceMessage = await bot.sendDice(session.chat_id, { emoji: '🎳' });
            const rollValue = diceMessage.dice.value;
            await sleep(4000);
            
            const win = (String(choice) === String(rollValue));
            let payoutAmount = 0n;
            if (win) {
                // Calculate profit only. Main bot adds bet back.
                const profit = BigInt(session.bet_amount_lamports) * BigInt(Math.floor(PINPOINT_BOWLING_PAYOUT_MULTIPLIER * 10)) / 10n;
                payoutAmount = profit;
            }
            await pool.query("UPDATE interactive_game_sessions SET status = $1, final_payout_lamports = $2 WHERE session_id = $3", [win ? 'completed_win' : 'completed_loss', payoutAmount.toString(), session.session_id]);
            await bot.deleteMessage(session.chat_id, diceMessage.message_id).catch(()=>{});
            break;
            
        case '3pt_shoot':
            await processThreePointShot(session.session_id);
            break;

        case '3pt_cashout':
            const gameState = JSON.parse(session.game_state_json || '{}');
            const currentMultiplier = gameState.currentMultiplier || 0;
            if (currentMultiplier > 0) {
                const finalPayout = BigInt(session.bet_amount_lamports) * BigInt(Math.floor(currentMultiplier * 100)) / 100n;
                await pool.query("UPDATE interactive_game_sessions SET status = 'completed_cashout', final_payout_lamports = $1 WHERE session_id = $2", [finalPayout.toString(), session.session_id]);
                await queuedSendMessage(session.chat_id, `💰 You cashed out with a multiplier of <b>x${currentMultiplier.toFixed(2)}</b>! The main bot will process your winnings shortly.`, { parse_mode: 'HTML' });
            }
            break;
    }
});

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setInterval(processInteractiveGames, 2500); // Poll for new games every 2.5 seconds
