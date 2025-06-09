// helper_bot.js - FINAL VERSION with All New Game Modes

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
const PINPOINT_BOWLING_PAYOUT_MULTIPLIER = 5.5; // For the original prediction game
const DARTS_FORTUNE_PAYOUTS = { 6: 3.5, 5: 1.5, 4: 0.5, 3: 0.2, 2: 0.1, 1: 0.0 }; // For the original darts game
const BOWLING_FRAMES = 3;
const BASKETBALL_SHOTS = 3;

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
            
            // --- UPDATED GAME ROUTER ---
            switch (session.game_type) {
                // Original PvB Games
                case 'bowling':
                    await runOriginalPinpointBowling(session);
                    break;
                case 'darts':
                    await runDartsFortune(session);
                    break;
                case 'basketball':
                    await runThreePointShootout(session);
                    break;
                
                // New Duel Games
                case 'bowling_duel': // New PvB Three-Frame Showdown
                    await runBowlingDuel(session);
                    break;
                case 'bowling_duel_pvp':
                case 'darts_duel_pvp':
                case 'basketball_clash_pvp':
                    await runInteractivePvP(session);
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


// --- ORIGINAL PvB GAME LOGIC (KEPT AS IS) ---

async function runOriginalPinpointBowling(session) {
    const messageTextHTML = `🎳 <b>Pinpoint Bowling Challenge!</b> 🎳\n\n` +
        `<b>Predict the exact outcome of the roll!</b>\n\n` +
        `Choose your target pin below. You have ${PLAYER_CHOICE_TIMEOUT / 1000} seconds.`;

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


// --- NEW DUEL GAME LOGIC (PvB & PvP) ---

async function runBowlingDuel(session) {
    const logPrefix = `[Helper_BowlingDuel_PvB SID:${session.session_id}]`;
    const tempMsg = await queuedSendMessage(session.chat_id, `🎳 **Your Turn:** Rolling 3 frames...`);
    
    let playerRolls = [];
    for (let i = 0; i < BOWLING_FRAMES; i++) {
        const diceMsg = await bot.sendDice(session.chat_id, { emoji: '🎳' });
        await sleep(2200);
        playerRolls.push(diceMsg.dice.value);
        await bot.deleteMessage(session.chat_id, diceMsg.message_id).catch(()=>{});
    }
    const playerScore = playerRolls.reduce((a, b) => a + b, 0);
    const playerResultMsg = await queuedSendMessage(session.chat_id, `Your final score: <b>${playerScore}</b> (${playerRolls.join(' + ')})`);
    await bot.deleteMessage(session.chat_id, tempMsg.message_id).catch(()=>{});
    
    await sleep(1500);
    const tempMsgBot = await queuedSendMessage(session.chat_id, `🤖 **Bot's Turn:** Rolling 3 frames...`);

    let botRolls = [];
    for (let i = 0; i < BOWLING_FRAMES; i++) {
        const diceMsg = await bot.sendDice(session.chat_id, { emoji: '🎳' });
        await sleep(2200);
        botRolls.push(diceMsg.dice.value);
        await bot.deleteMessage(session.chat_id, diceMsg.message_id).catch(()=>{});
    }
    const botScore = botRolls.reduce((a, b) => a + b, 0);
    const botResultMsg = await queuedSendMessage(session.chat_id, `Bot's final score: <b>${botScore}</b> (${botRolls.join(' + ')})`);

    await bot.deleteMessage(session.chat_id, tempMsgBot.message_id).catch(()=>{});
    await sleep(4000);
    await bot.deleteMessage(session.chat_id, playerResultMsg.message_id).catch(()=>{});
    await bot.deleteMessage(session.chat_id, botResultMsg.message_id).catch(()=>{});

    let finalStatus = (playerScore > botScore) ? 'completed_win' : (botScore > playerScore) ? 'completed_loss' : 'completed_push';
    let finalPayout = 0n;

    if (finalStatus === 'completed_win') {
        finalPayout = BigInt(session.bet_amount_lamports) * 2n;
    } else if (finalStatus === 'completed_push') {
        finalPayout = BigInt(session.bet_amount_lamports);
    }
    
    const finalGameState = { ...session.game_state_json, playerScore, botScore };
    await pool.query("UPDATE interactive_game_sessions SET status = $1, final_payout_lamports = $2, game_state_json = $3 WHERE session_id = $4", [finalStatus, finalPayout.toString(), JSON.stringify(finalGameState), session.session_id]);
    await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
}

async function runInteractivePvP(session) {
    const logPrefix = `[Helper_PvP SID:${session.session_id} Type:${session.game_type}]`;
    const gameState = session.game_state_json || {};
    const p1Name = gameState.initiatorName || "Player 1";
    const p2Name = gameState.opponentName || "Player 2";
    
    let shots = 1, emoji = '🎲', gameName = "Duel";
    switch(session.game_type) {
        case 'bowling_duel_pvp': shots = BOWLING_FRAMES; emoji = '🎳'; gameName = "Bowling Duel"; break;
        case 'darts_duel_pvp': shots = 1; emoji = '🎯'; gameName = "Darts Showdown"; break;
        case 'basketball_clash_pvp': shots = BASKETBALL_SHOTS; emoji = '🏀'; gameName = "3-Point Clash"; break;
    }
    
    const tempDuelMsg = await queuedSendMessage(session.chat_id, `⚔️ <b>${gameName}</b>: ${p1Name} vs. ${p2Name} ⚔️\nRolling for both players...`, { parse_mode: 'HTML' });

    let p1Rolls = [], p2Rolls = [];
    
    const tempP1Msg = await queuedSendMessage(session.chat_id, `Rolling for <b>${p1Name}</b>...`, { parse_mode: 'HTML' });
    for (let i = 0; i < shots; i++) {
        const diceMsg = await bot.sendDice(session.chat_id, { emoji });
        await sleep(2200);
        p1Rolls.push(diceMsg.dice.value);
        await bot.deleteMessage(session.chat_id, diceMsg.message_id).catch(()=>{});
    }
    const p1Score = (gameName === "3-Point Clash") ? p1Rolls.filter(r => r >= 4).length : p1Rolls.reduce((a, b) => a + b, 0);
    const p1ResultMsg = await queuedSendMessage(session.chat_id, `<b>${p1Name}'s</b> final score: <b>${p1Score}</b>`);
    await bot.deleteMessage(session.chat_id, tempP1Msg.message_id).catch(()=>{});

    await sleep(1500);

    const tempP2Msg = await queuedSendMessage(session.chat_id, `Rolling for <b>${p2Name}</b>...`, { parse_mode: 'HTML' });
    for (let i = 0; i < shots; i++) {
        const diceMsg = await bot.sendDice(session.chat_id, { emoji });
        await sleep(2200);
        p2Rolls.push(diceMsg.dice.value);
        await bot.deleteMessage(session.chat_id, diceMsg.message_id).catch(()=>{});
    }
    const p2Score = (gameName === "3-Point Clash") ? p2Rolls.filter(r => r >= 4).length : p2Rolls.reduce((a, b) => a + b, 0);
    const p2ResultMsg = await queuedSendMessage(session.chat_id, `<b>${p2Name}'s</b> final score: <b>${p2Score}</b>`);
    await bot.deleteMessage(session.chat_id, tempP2Msg.message_id).catch(()=>{});

    await bot.deleteMessage(session.chat_id, tempDuelMsg.message_id).catch(()=>{});
    await sleep(4000);
    await bot.deleteMessage(session.chat_id, p1ResultMsg.message_id).catch(()=>{});
    await bot.deleteMessage(session.chat_id, p2ResultMsg.message_id).catch(()=>{});
    
    let finalStatus = (p1Score > p2Score) ? 'completed_p1_win' : (p2Score > p1Score) ? 'completed_p2_win' : 'completed_push';
    const finalGameState = { ...gameState, p1Score, p2Score, p1Rolls, p2Rolls };
    
    // Payout is handled by main bot, helper just determines winner
    await pool.query("UPDATE interactive_game_sessions SET status = $1, game_state_json = $2 WHERE session_id = $3", [finalStatus, JSON.stringify(finalGameState), session.session_id]);
    await pool.query(`NOTIFY game_completed, '${JSON.stringify({ session_id: session.session_id })}'`);
}


// --- INTERACTIVE PvB LOGIC (BASKETBALL - this is unchanged) ---

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


// --- MAIN CALLBACK ROUTER (UNCHANGED) ---

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

// --- Main Execution ---
console.log('🚀 Helper Bot starting...');
setInterval(processInteractiveGames, GAME_LOOP_INTERVAL);
