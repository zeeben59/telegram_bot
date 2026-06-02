// Simple, production-ready Telegram AI bot using Telegraf and OpenAI
// CommonJS syntax (require)

require('dotenv').config(); // Load .env into process.env

const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const express = require('express');
const cron = require('node-cron');

// Read required environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_NAME = process.env.OWNER_NAME || 'the bot owner';
const OWNER_WHATSAPP = process.env.OWNER_WHATSAPP || null;
const OWNER_PORTFOLIO = process.env.OWNER_PORTFOLIO || null;
const OWNER_EMAIL = process.env.OWNER_EMAIL || null;
const OWNER_PHOTO_URL = process.env.OWNER_PHOTO_URL || null;
const SILENT_LOGS = (process.env.SILENT_LOGS || 'false').toLowerCase() === 'true';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment. Please set it in .env');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment. Please set it in .env');
  process.exit(1);
}

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const db = require('./db');
// In-memory timers for motivational messages (per user)
const motivTimers = new Map();
// In-memory onboarding states: userId -> { step: number, answers: {} }
const onboardStates = new Map();
// Typing action intervals per chat to keep the "..." animation visible
const typingTimers = new Map();

function startTyping(ctxOrId) {
  try {
    let chatId = null;
    if (typeof ctxOrId === 'object' && ctxOrId !== null) {
      chatId = ctxOrId.chat && ctxOrId.chat.id ? ctxOrId.chat.id : (ctxOrId.from && ctxOrId.from.id ? ctxOrId.from.id : null);
    } else {
      chatId = ctxOrId;
    }
    if (!chatId) return;
    // normalize to string key
    const key = String(chatId);
    if (typingTimers.has(key)) return;
    try { bot.telegram.sendChatAction(chatId, 'typing'); } catch (e) { /* ignore */ }
    const iv = setInterval(() => {
      try { bot.telegram.sendChatAction(chatId, 'typing'); } catch (e) { /* ignore */ }
    }, 4000);
    typingTimers.set(key, iv);
  } catch (e) { /* ignore */ }
}

function stopTyping(ctxOrId) {
  try {
    let chatId = null;
    if (typeof ctxOrId === 'object' && ctxOrId !== null) {
      chatId = ctxOrId.chat && ctxOrId.chat.id ? ctxOrId.chat.id : (ctxOrId.from && ctxOrId.from.id ? ctxOrId.from.id : null);
    } else {
      chatId = ctxOrId;
    }
    if (!chatId) return;
    const key = String(chatId);
    const iv = typingTimers.get(key);
    if (iv) {
      clearInterval(iv);
      typingTimers.delete(key);
    }
  } catch (e) { /* ignore */ }
}
const MOTIVATION_DELAY_MINUTES = parseInt(process.env.MOTIVATION_DELAY_MINUTES || '10', 10);
const MOTIVATION_ENABLED = (process.env.MOTIVATION_ENABLED || 'true').toLowerCase() === 'true';

// /reset command: clear a user's conversation history
bot.command('reset', (ctx) => {
  try {
    const userId = ctx.from && (ctx.from.username || ctx.from.id);
    // remove DB messages for this user
    try { db.clearMessages(userId); } catch (e) {}
    ctx.reply('Conversation history cleared.');
  } catch (e) {
    console.error('Failed to reset conversation:', e);
    ctx.reply('Failed to clear conversation history.');
  }
});

// /onboard command - start guided onboarding
bot.command('onboard', async (ctx) => {
  const userId = ctx.from && (ctx.from.id || ctx.from.username);
  onboardStates.set(String(userId), { step: 0, answers: {} });
  await ctx.reply('Welcome! I will ask a few questions to personalise your coaching. You can type "cancel" anytime to stop.');
  await ctx.reply('1) What is your career or academic goal?');
});

// /history command: show a safe preview of recent turns
bot.command('history', async (ctx) => {
  try {
    const userId = ctx.from && (ctx.from.username || ctx.from.id);
    const convo = await db.getRecentMessages(userId) || [];
    if (!convo.length) return ctx.reply('No recent conversation history.');
    const last = convo.slice(-10).map((m, i) => `${i + 1}. ${m.role}: ${m.text.substring(0, 200)}`);
    ctx.reply(`Last messages:\n${last.join('\n\n')}`);
  } catch (e) {
    console.error('Failed to fetch history:', e);
    ctx.reply('Could not retrieve history.');
  }
});

// /tasks command: explicitly request tasks from the coach
bot.command('tasks', async (ctx) => {
  try {
    const userId = ctx.from && (ctx.from.username || ctx.from.id);
    const recent = await db.getRecentMessages(userId, 40);
    const profile = await db.getProfile(userId) || {};
    const convoText = recent.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
    const profileSummary = Object.keys(profile).length ? `Profile: ${JSON.stringify(profile)}` : 'Profile: (none)';
    const prompt = `You are AI_Coach. The user asked for tasks. Use the user's profile and the conversation below to create 3 focused, achievable tasks for today that directly advance the user's long-term goals. Prioritise tasks by the user's career_goal, department, study_hours, year, and future_vision when present. Respect the user's available study hours and avoid overwhelming suggestions. ${profileSummary}\nConversation:\n${convoText}`;
    startTyping(ctx);
    try {
      const response = await openai.responses.create({ model: 'gpt-4.1-mini', input: prompt, max_output_tokens: 400, temperature: 0.12 });
      let aiText = response.output_text || (Array.isArray(response.output) && response.output.map(b=>b.content?.map(c=>c.text||'').join('')).join('\n')) || 'Sorry, could not generate tasks.';
      aiText = await ensureHumanTone(aiText);
      await ctx.reply(aiText);
      await db.saveMessage(userId, 'assistant', aiText);
      // Parse and persist tasks so the user can view them later via /tasks
      try {
        const parsed = parseTasksFromText(aiText);
        for (const t of parsed) {
          await db.saveTask(userId, t);
        }
      } catch (e) {
        console.error('Failed to parse/save tasks from /tasks response:', e);
      }
    } catch (e) {
      console.error('Failed to generate tasks:', e);
      ctx.reply('Could not generate tasks right now.');
    } finally {
      stopTyping(ctx);
    }
  } catch (e) {
    console.error('Failed to generate tasks:', e);
    ctx.reply('Could not generate tasks right now.');
  }
});

if (!SILENT_LOGS) console.log('Starting Telegram AI bot...');

// Diagnostic logs: do not print secrets, only presence and lengths
if (!SILENT_LOGS) console.log('ENV check: BOT_TOKEN', BOT_TOKEN ? `present (length ${BOT_TOKEN.length})` : 'MISSING');
if (!SILENT_LOGS) console.log('ENV check: OPENAI_API_KEY', OPENAI_API_KEY ? `present (length ${OPENAI_API_KEY.length})` : 'MISSING');
if (!SILENT_LOGS) console.log('ENV check: OWNER_NAME', OWNER_NAME ? `present (length ${OWNER_NAME.length})` : 'MISSING');
if (!SILENT_LOGS) console.log('ENV check: OWNER_WHATSAPP', OWNER_WHATSAPP ? `present (length ${OWNER_WHATSAPP.length})` : 'MISSING');
if (!SILENT_LOGS) console.log('ENV check: OWNER_PORTFOLIO', OWNER_PORTFOLIO ? `present (length ${OWNER_PORTFOLIO.length})` : 'MISSING');

// /start command
bot.start((ctx) => {
  if (!SILENT_LOGS) console.log('Received /start from', ctx.from && ctx.from.username ? ctx.from.username : ctx.from.id);
  try {
    let startMsg = `Hello there — I\'m your AI Coach. How can I help you today?`;
    // Inline keyboard with quick actions
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Get Started', callback_data: 'get_started' },
            { text: 'Contact Owner', callback_data: 'contact_owner' }
          ]
        ]
      }
    };
    ctx.reply(startMsg, keyboard);
  } catch (e) {
    console.error('Error in /start handler:', e);
    ctx.reply('Hello! I\'m an AI assistant powered by OpenAI. Send me any message and I\'ll reply.');
  }
});

// Actions for inline buttons shown on /start
bot.action('get_started', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply('Great — tell me briefly what you want help with (goal, problem, or topic).');
  } catch (e) {
    console.error('get_started action failed:', e);
  }
});

bot.action('contact_owner', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    let reply = `Owner: ${OWNER_NAME}`;
    if (OWNER_WHATSAPP) reply += `\nWhatsApp: ${OWNER_WHATSAPP}`;
    if (OWNER_EMAIL) reply += `\nEmail: ${OWNER_EMAIL}`;
    if (OWNER_PORTFOLIO) reply += `\nPortfolio: ${OWNER_PORTFOLIO}`;
    // If photo URL provided, send photo with caption; otherwise send text
    if (OWNER_PHOTO_URL) {
      await ctx.replyWithPhoto(OWNER_PHOTO_URL, { caption: reply });
    } else {
      await ctx.reply(reply);
    }
  } catch (e) {
    console.error('contact_owner action failed:', e);
  }
});

// /owner command
bot.command('owner', (ctx) => {
  try {
    let reply = `This bot is owned by ${OWNER_NAME}.`;
    if (OWNER_WHATSAPP) reply += ` Reach out via WhatsApp: ${OWNER_WHATSAPP}.`;
    if (OWNER_PORTFOLIO) reply += ` Portfolio: ${OWNER_PORTFOLIO}.`;
    ctx.reply(reply);
  } catch (e) {
    console.error('Failed to reply to /owner command:', e);
  }
});

// /contact command
bot.command('contact', (ctx) => {
  try {
    let reply = `You can contact ${OWNER_NAME}.`;
    if (OWNER_WHATSAPP) reply += ` WhatsApp: ${OWNER_WHATSAPP}.`;
    if (OWNER_PORTFOLIO) reply += ` Portfolio: ${OWNER_PORTFOLIO}.`;
    ctx.reply(reply);
  } catch (e) {
    console.error('Failed to reply to /contact command:', e);
  }
});

// /viewtasks command: list persisted pending tasks for the user
bot.command('viewtasks', async (ctx) => {
  try {
    const userId = ctx.from && (ctx.from.username || ctx.from.id);
    const tasks = await db.getTasksForUser(userId, true);
    if (!tasks || tasks.length === 0) return ctx.reply('You have no pending tasks.');
    const lines = tasks.map(t => `#${t.id} [${t.category || 'task'}] ${t.title} (${t.estimate_min || '?'} min)`);
    await ctx.reply(`Your pending tasks:\n${lines.join('\n')}`);
  } catch (e) {
    console.error('Failed to fetch tasks for user:', e);
    ctx.reply('Could not retrieve tasks.');
  }
});

// /setpref command: set a simple profile preference (e.g., show_tasks_by_default true|false)
bot.command('setpref', async (ctx) => {
  try {
    const userId = ctx.from && (ctx.from.id || ctx.from.username);
    const parts = (ctx.message && ctx.message.text ? ctx.message.text.trim().split(/\s+/) : []);
    if (parts.length < 3) return ctx.reply('Usage: /setpref <key> <value>. Example: /setpref show_tasks_by_default true');
    const key = parts[1];
    const valRaw = parts[2].toLowerCase();
    let value;
    if (valRaw === 'true' || valRaw === '1') value = true;
    else if (valRaw === 'false' || valRaw === '0') value = false;
    else value = valRaw;
    const profile = await db.getProfile(userId) || {};
    profile[key] = value;
    await db.saveProfile(userId, profile);
    return ctx.reply(`Preference ${key} set to ${value}`);
  } catch (e) {
    console.error('Failed to set preference:', e);
    return ctx.reply('Could not set preference.');
  }
});

// /done command: mark a task as completed by id
bot.command('done', async (ctx) => {
  try {
    const userId = ctx.from && (ctx.from.username || ctx.from.id);
    const text = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
    // extract numeric id after the command
    const m = text.match(/\s*(?:\/done)(?:@\w+)?\s+#?(\d+)/i);
    if (!m) return ctx.reply('Usage: /done <task_id> — e.g. /done 3');
    const taskId = parseInt(m[1], 10);
    if (Number.isNaN(taskId)) return ctx.reply('Invalid task id. Use the numeric id shown in /viewtasks.');
    await db.updateTaskCompletion(taskId, true);
    await ctx.reply(`Marked task #${taskId} as completed. Great work! 🎉`);
    try { await db.saveMessage(userId, 'user', `/done ${taskId}`); } catch (e) { /* ignore save errors */ }
  } catch (e) {
    console.error('Failed to mark task done:', e);
    ctx.reply('Could not mark that task as done.');
  }
});

// Handle text messages
bot.on('text', async (ctx) => {
  const userId = ctx.from && (ctx.from.username || ctx.from.id);
  const userText = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';

  if (!SILENT_LOGS) console.log('Message from', userId, ':', userText);

  if (!userText) {
    return ctx.reply('Please send a text message.');
  }

  // Quick owner question detection to answer locally without calling OpenAI
  try {
    const ownerRegex = /(who\s+(is|'s)?\s+(the\s+)?(own|owner|creator|maker)|who\s+made|who\s+owns|who\s+created)/i;
    const contactRegex = /(how\s+do\s+i\s+(reach|contact)|contact\s+(the\s+)?(owner|creator|maker)|whatsapp|phone|portfolio|website|site|visit\s+your|reach\s+you)/i;
    if (ownerRegex.test(userText)) {
      let reply = `This bot is owned by ${OWNER_NAME}.`;
      if (OWNER_WHATSAPP) reply += ` WhatsApp: ${OWNER_WHATSAPP}.`;
      if (OWNER_PORTFOLIO) reply += ` Portfolio: ${OWNER_PORTFOLIO}.`;
      return ctx.reply(reply);
    }
    if (contactRegex.test(userText)) {
      let reply = `You can contact ${OWNER_NAME}.`;
      if (OWNER_WHATSAPP) reply += ` WhatsApp: ${OWNER_WHATSAPP}.`;
      if (OWNER_PORTFOLIO) reply += ` Portfolio: ${OWNER_PORTFOLIO}.`;
      return ctx.reply(reply);
    }
  } catch (e) {
    console.error('Owner regex test failed:', e);
  }

  try {
    // Ensure user record exists (store numeric id and username)
    try { await db.saveUser(String(ctx.from.id), ctx.from.username || null); } catch (e) { /* ignore */ }

    // Onboarding flow handling (if active)
    const stateKey = String(ctx.from.id);
    if (onboardStates.has(stateKey)) {
      const state = onboardStates.get(stateKey);
      const step = state.step;
      if (/^cancel$/i.test(userText)) {
        onboardStates.delete(stateKey);
        await ctx.reply('Onboarding cancelled.');
        return;
      }
      const questions = [
        'What is your career or academic goal?',
        'What course/department are you studying?',
        'What year are you in?',
        'What is your biggest struggle?',
        'How many hours can you study daily?',
        'What habits are hurting your progress?',
        'What kind of future do you want for yourself?'
      ];
      const keyMap = ['career_goal','department','year','biggest_struggle','study_hours','bad_habits','future_vision'];
      state.answers[keyMap[step]] = userText;
      state.step += 1;
      if (state.step >= questions.length) {
        try { await db.saveProfile(String(ctx.from.id), state.answers); } catch (e) { console.error('Failed to save profile during onboarding:', e); }
        onboardStates.delete(stateKey);
        await ctx.reply('Thanks — I saved your profile and will personalise your coaching now.');
        return;
      }
      onboardStates.set(stateKey, state);
      await ctx.reply((state.step + 1) + ') ' + questions[state.step]);
      return;
    }

    // Save user message persistently
    await db.saveMessage(userId, 'user', userText);

    // Keep typing animation visible while generating
    startTyping(ctx);

    // Quick "remember" handling: save short user notes like "remember that I..."
    try {
      const rem = userText.match(/^remember(?: that)?\s+(.+)/i);
      if (rem) {
        const note = rem[1].trim();
        const profileExisting = await db.getProfile(userId) || {};
        const notes = profileExisting.notes || [];
        notes.push({ text: note, ts: Date.now() });
        profileExisting.notes = notes;
        await db.saveProfile(userId, profileExisting);
        await ctx.reply(`Got it — I'll remember: "${note}"`);
        await db.saveMessage(userId, 'assistant', `Saved memory: ${note}`);
        return;
      }
    } catch (e) {
      console.error('Failed to save memory note:', e);
    }

    // Natural language intent detection: tasks/goals/habits/deadlines/emotion
    const intent = await detectIntent(userText);
    if (intent === 'add_task') {
      // Try to extract a simple task (very small parser)
      const match = userText.match(/(?:add|create|schedule|remind).*?(?:to )?(.+)/i);
      const title = match ? match[1].trim() : userText;
      await db.saveTask(userId, { title, category: 'user', estimate_min: null, due_date: null });
      await ctx.reply(`Task saved: "${title}". Use /tasks to view tasks.`);
      return;
    }
    if (intent === 'ask_tasks') {
      // Delegate to /tasks handler flow
      const recent2 = await db.getRecentMessages(userId, 40);
      const convoText2 = recent2.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
      const prompt2 = `You are AI_Coach. The user asked for tasks. Use the conversation below to create 3 focused, achievable tasks for today. Include category, one-line instruction, and estimated time in minutes. Conversation:\n${convoText2}`;
      startTyping(ctx);
      try {
        // include profile when generating tasks
        const profile2 = await db.getProfile(userId) || {};
        const profileSummary2 = Object.keys(profile2).length ? `Profile: ${JSON.stringify(profile2)}` : 'Profile: (none)';
        const prompt2WithProfile = `${prompt2}\n${profileSummary2}`;
        const response2 = await openai.responses.create({ model: 'gpt-4.1-mini', input: prompt2WithProfile, max_output_tokens: 400, temperature: 0.12 });
        let aiText2 = response2.output_text || (Array.isArray(response2.output) && response2.output.map(b=>b.content?.map(c=>c.text||'').join('')).join('\n')) || 'Sorry, could not generate tasks.';
        aiText2 = await ensureHumanTone(aiText2);
        await ctx.reply(aiText2);
        await db.saveMessage(userId, 'assistant', aiText2);
        // Parse and persist tasks so they are visible via /tasks
        try {
          const parsed2 = parseTasksFromText(aiText2);
          for (const t of parsed2) await db.saveTask(userId, t);
        } catch (e) {
          console.error('Failed to parse/save tasks from ask_tasks flow:', e);
        }
      } catch (e) {
        console.error('ask_tasks flow failed:', e);
        await ctx.reply('Sorry, I could not generate tasks right now.');
      } finally {
        stopTyping(ctx);
      }
      return;
    }
    if (intent === 'share_feeling') {
      // Short encouraging reply without tasks
      await ctx.reply('I hear you — that\'s normal. Let\'s break your next session into a tiny task: what is one small thing you can do in 10 minutes?');
      await db.saveMessage(userId, 'assistant', 'Encouragement prompt asking for a 10-minute tiny task.');
      return;
    }
    // Detect profile statements like "My major is X" or "My career goal is Y" and save as profile
    const profile = parseProfileFromText(userText);
    if (profile) {
      try {
        await db.saveProfile(userId, profile);
        await ctx.reply('Thanks — I saved your profile information.');
      } catch (e) {
        console.error('Failed to save profile:', e);
        await ctx.reply('I tried to save your profile but something went wrong.');
      }
      return;
    }

    // Build conversation context: include recent turns from DB
    const recent = await db.getRecentMessages(userId, 40) || [];
    const convoForRequest = recent.concat([{ role: 'user', text: userText }]);

    // Strong system prompt to ensure the assistant behaves like the AI Coach
      const systemIntro = `You are AI_Coach, an advanced AI mentor for university students. Follow these behavior rules strictly:
      // Tone: friendly, human, concise. Reply like a helpful coach.
      // Use short, natural language (1-3 short sentences). Be warm and motivating.
      // Use casual-but-respectful phrasing; emojis allowed sparingly to increase warmth.
      // Focus on studying, productivity, career growth, and realistic next steps.
      // Provide one very short practical suggestion or micro-action when relevant.
      // When the user feels stuck: reduce overwhelm, suggest a tiny immediate action (5-15 minutes).
      // When the user shows progress: celebrate briefly and suggest a small next step.
      // When asked for plans or tasks: generate concise, prioritized micro-tasks (3 items max).
      // Ask one short follow-up question only when it clearly improves personalization.
      // Keep replies fast, human, and easy to read.`;

    const convoText = convoForRequest.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
    const fullPrompt = `${systemIntro}\n\nConversation:\n${convoText}\n\nRespond as the AI Coach. Format your reply as:\n- Short motivational note (1-2 sentences)\n- One concise, practical answer addressing the user's message (no task list unless the user asked for tasks)\n- Suggested study technique or one short actionable tip (if relevant)\n- One follow-up question to personalise further\nKeep the whole reply concise, helpful, and focused on the user's request.`;

    startTyping(ctx);
    let response;
    try {
      response = await openai.responses.create({
          model: 'gpt-4.1-mini',
          input: fullPrompt,
          max_output_tokens: 800,
          temperature: 0.1,
        });
    } catch (e) {
      console.error('AI generation failed:', e);
      stopTyping(ctx);
      await ctx.reply('Sorry, I received an error generating a reply.');
      return;
    } finally {
      // ensure we stop typing after generation attempt; actual reply will follow
      stopTyping(ctx);
    }

    // Extract text from response robustly. The SDK may return `output_text`
    // or a structured `output` array with content blocks.
    let aiText = '';
    if (response.output_text && typeof response.output_text === 'string') {
      aiText = response.output_text;
    } else if (Array.isArray(response.output)) {
      for (const block of response.output) {
        if (!block || !Array.isArray(block.content)) continue;
        for (const item of block.content) {
          if (!item) continue;
          if (typeof item === 'string') aiText += item;
          else if (item.text) aiText += item.text;
          else if (item.type === 'output_text' && item.text) aiText += item.text;
          else if (item.type === 'output' && Array.isArray(item.parts)) aiText += item.parts.join('');
        }
      }
    }
    if (!aiText) aiText = 'Sorry, I received an unexpected response from the AI.';
    // Ensure human, short, motivating tone
    aiText = await ensureHumanTone(aiText);

    // Send the AI response back to the user
    stopTyping(ctx);
    await ctx.reply(aiText);
    if (!SILENT_LOGS) console.log('Replied to', userId);

    // Save assistant reply
    await db.saveMessage(userId, 'assistant', aiText);

    // Reset motivational timer for this user
    try {
      if (motivTimers.has(userId)) {
        clearTimeout(motivTimers.get(userId));
      }
      if (MOTIVATION_ENABLED && MOTIVATION_DELAY_MINUTES > 0) {
        const t = setTimeout(async () => {
          try {
            const quotes = [
              'Small steps = big progress. Try one focused 15-minute session. 💪',
              'You\'re closer than you think — start with one tiny action now. ✨',
              'Consistency wins. Do 10 minutes of focused work and stop. You got this.'
            ];
            const note = quotes[Math.floor(Math.random() * quotes.length)];
            await ctx.reply(`Motivation: ${note}`);
            await db.saveMessage(userId, 'assistant', `Motivation: ${note}`);
          } catch (e) {
            console.error('Failed to send motivational message:', e);
          }
        }, MOTIVATION_DELAY_MINUTES * 60 * 1000);
        motivTimers.set(userId, t);
      }
    } catch (e) {
      console.error('Failed to set motivational timer:', e);
    }
  } catch (err) {
    // Log detailed error for debugging
    console.error('Error while handling message:', err);
    try {
      await ctx.reply('Sorry, something went wrong while contacting the AI.');
    } catch (replyErr) {
      console.error('Also failed to send error reply to user:', replyErr);
    }
  }
});

// OpenAI-backed intent detection with keyword fallback.
// Returns one of: add_task, ask_tasks, set_goal, add_habit, set_deadline, share_feeling, unknown
async function detectIntent(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase();

  // Fast keyword rules first (cheap, instant)
  if (/\b(plan|roadmap|strategy|plan for|plan my)\b/.test(t)) return 'ask_tasks';
  if (/\b(add|create|schedule|remind|todo|task)\b/.test(t) && /\b(to|for)\b/.test(t)) return 'add_task';
  if (/\b(give( me)?( a)? tasks?|give( me)?( a)? task|give task|can you give( me)?( a)? task|what should i do|assign tasks|tasks for (today|now)|suggest tasks|i need tasks)\b/.test(t)) return 'ask_tasks';
  if (/\b(goal|career goal|my goal|objective)\b/.test(t)) return 'set_goal';
  if (/\b(habit|habitual|routine|daily habit)\b/.test(t)) return 'add_habit';
  if (/\b(deadline|due|when is|due date)\b/.test(t)) return 'set_deadline';
  if (/\b(sad|depressed|anxious|stressed|lazy|unmotivated|tired|overwhelmed)\b/.test(t)) return 'share_feeling';

  // If keyword detection returned no strong match, consult OpenAI to classify intent.
  try {
    const classifierSystem = `You are a strict intent classifier. Given a user's short message, choose the best single intent from the following list: add_task, ask_tasks, set_goal, add_habit, set_deadline, share_feeling, unknown. Respond ONLY with a JSON object exactly like {"intent":"<one_of_the_above>","confidence":<0-1>}. Do not output any extra text.`;
    const prompt = `${classifierSystem}\n\nUser message: "${text.replace(/\"/g, '\\"')}"`;
    const resp = await openai.responses.create({ model: 'gpt-4.1-mini', input: prompt, max_output_tokens: 60, temperature: 0 });
    let out = '';
    if (typeof resp.output_text === 'string' && resp.output_text.trim()) out = resp.output_text.trim();
    else if (Array.isArray(resp.output)) {
      for (const block of resp.output) {
        if (!block || !Array.isArray(block.content)) continue;
        for (const item of block.content) {
          if (!item) continue;
          if (typeof item === 'string') out += item;
          else if (item.text) out += item.text;
        }
      }
      out = out.trim();
    }
    // Try to extract JSON
    let parsed = null;
    try {
      const firstBrace = out.indexOf('{');
      const jsonText = firstBrace >= 0 ? out.slice(firstBrace) : out;
      parsed = JSON.parse(jsonText);
    } catch (e) {
      // ignore parse errors
    }
    if (parsed && parsed.intent) {
      const intent = String(parsed.intent).trim();
      if (['add_task','ask_tasks','set_goal','add_habit','set_deadline','share_feeling','unknown'].includes(intent)) return intent;
    }
  } catch (e) {
    if (!SILENT_LOGS) console.warn('Intent classifier failed, falling back to keywords:', e && e.message ? e.message : e);
  }

  return 'unknown';
}

function parseProfileFromText(text) {
  if (!text) return null;
  const t = text;
  const profile = {};
  const majorMatch = t.match(/major is ([\w\s&+-]+)/i) || t.match(/i am studying ([\w\s&+-]+)/i);
  if (majorMatch) profile.major = majorMatch[1].trim();
  const goalMatch = t.match(/career goal is ([\w\s,.-]+)/i) || t.match(/goal is to become ([\w\s,.-]+)/i);
  if (goalMatch) profile.career_goal = goalMatch[1].trim();
  const hoursMatch = t.match(/study about (\d+) hours/i) || t.match(/(\d+) hours (daily|a day|per day)/i);
  if (hoursMatch) profile.study_hours = parseInt(hoursMatch[1], 10);
  if (Object.keys(profile).length === 0) return null;
  return profile;
}

// Parse tasks from generated assistant text. Returns array of { title, category, estimate_min }
function parseTasksFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const tasks = [];
  for (let line of lines) {
    line = line.trim();
    // match lines like "1. Study – Do X (30 minutes)" or "1) Skill - Do Y 20 minutes"
    const m = line.match(/^\s*\d+\s*[\.|\)]\s*(.+)/);
    if (!m) continue;
    let rest = m[1].trim();
    // try split category from rest if present like "Study – Review notes..."
    let category = 'suggested';
    const catSplit = rest.split(/\s+[–—-]\s+|\s+[-–—]\s+/);
    if (catSplit.length > 1) {
      const possibleCat = catSplit[0].trim();
      if (/study|skill|habit|practice|exercise/i.test(possibleCat)) category = possibleCat.toLowerCase();
      rest = catSplit.slice(1).join(' - ').trim();
    }
    // extract estimate in minutes if present
    let estimate = null;
    const estMatch = rest.match(/(?:\((\d+)\s*(?:minutes|minute|min)\)|(\d+)\s*(?:minutes|minute|min))/i);
    if (estMatch) estimate = parseInt(estMatch[1] || estMatch[2], 10);
    // clean parentheses with minutes
    rest = rest.replace(/\(\d+\s*(?:minutes|minute|min)\)/i, '').trim();
    tasks.push({ title: rest, category, estimate_min: estimate });
  }
  return tasks;
}

// Simple heuristics to detect casual/non-professional replies
function isCasualReply(text) {
  if (!text || typeof text !== 'string') return false;
  // emojis
  if (/\p{Emoji}/u.test(text)) return true;
  // casual words/phrases
  const casual = ['ok', 'okay', 'no worries', 'cool', 'gonna', 'wanna', 'hey', 'cheers', 'yup', 'nah', 'lol', 'btw'];
  const lower = text.toLowerCase();
  for (const c of casual) if (lower.includes(c)) return true;
  // multiple exclamation marks
  if (/[!]{2,}/.test(text)) return true;
  return false;
}

// Rewrite assistant replies to be short, human, and motivating
async function ensureHumanTone(originalText) {
  try {
    // If already short enough, keep but trim
    if (typeof originalText === 'string' && originalText.trim().length <= 280) return originalText.trim();
    const rewriteInstr = `Rewrite the following assistant reply to be short, human, friendly, and motivating. Keep it to 1-3 short sentences, use natural language, and optionally one light emoji to add warmth. Preserve the original meaning and actionable suggestions. Reply only with the rewritten text.`;
    const prompt = `${rewriteInstr}\n\nOriginal reply:\n${originalText}`;
    const resp = await openai.responses.create({ model: 'gpt-4.1-mini', input: prompt, max_output_tokens: 300, temperature: 0.25 });
    const txt = resp.output_text || (Array.isArray(resp.output) && resp.output.map(b=>b.content?.map(c=>c.text||'').join('')).join('\n')) || '';
    const out = txt.trim();
    if (out) return out;
    return originalText.trim();
  } catch (e) {
    console.error('ensureHumanTone failed:', e);
    return originalText;
  }
}

// Minimal Express API to expose user profile and tasks
const app = express();
app.use(express.json());
app.get('/users/:id/profile', async (req, res) => {
  try {
    const profile = await db.getProfile(req.params.id);
    res.json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
app.get('/users/:id/tasks', async (req, res) => {
  try {
    const tasks = await db.getTasksForUser(req.params.id, false);
    res.json({ ok: true, tasks });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
const HTTP_PORT = process.env.PORT || 3000;
app.listen(HTTP_PORT, () => { if (!SILENT_LOGS) console.log('Express API listening on port', HTTP_PORT); });

// Daily scheduler: generate one personalized daily task message per user at 08:00 server time
cron.schedule('0 8 * * *', async () => {
  try {
    if (!SILENT_LOGS) console.log('Running daily task generator...');
    const users = await db.getAllUsers();
    for (const u of users) {
      try {
        const userId = u.id;
        const profile = await db.getProfile(userId) || {};
        const recent = await db.getRecentMessages(userId, 40);
        const convoText = recent.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
        const prompt = `You are AI_Coach. Create ONE daily mission for a university student based on this profile: ${JSON.stringify(profile)}. The mission must align with the student's long-term career_goal and future_vision, respect their study_hours, and be appropriate for their year and department. Also produce 3 small tasks (category, one-line instruction, estimated minutes). Conversation context:\n${convoText}`;
        const resp = await openai.responses.create({ model: 'gpt-4.1-mini', input: prompt, max_output_tokens: 300, temperature: 0.12 });
        let text = resp.output_text || (Array.isArray(resp.output) && resp.output.map(b=>b.content?.map(c=>c.text||'').join('')).join('\n')) || '';
        text = await ensureHumanTone(text);
        // save message and tasks
        await db.saveMessage(userId, 'assistant', text);
        const parsed = parseTasksFromText(text);
        for (const t of parsed) await db.saveTask(userId, t);
        // Only send if the user allows daily tasks (preference)
        try {
          const prefs = profile && profile.show_tasks_by_default === false ? { show: false } : { show: true };
          if (prefs.show) {
            const chatId = Number(userId) || userId;
            await bot.telegram.sendMessage(chatId, text);
          } else {
            if (!SILENT_LOGS) console.log('Skipping daily task send for', userId, 'due to preference');
          }
        } catch (e) {
          if (!SILENT_LOGS) console.warn('Could not send daily task to', userId, e && e.message ? e.message : e);
        }
      } catch (e) { console.error('Failed to generate/send daily task for user', u, e); }
    }
  } catch (e) { console.error('Daily task scheduler failed:', e); }
}, { scheduled: true, timezone: process.env.TIMEZONE || 'UTC' });

// Global error handling
bot.catch((err) => {
  console.error('Bot error:', err);
});

// Start the bot
// Launch the bot and log detailed progress so we can see where it stops.
(async () => {
  try {
    if (!SILENT_LOGS) console.log('Initializing database...');
    try { await db.init(); if (!SILENT_LOGS) console.log('Database initialized.'); } catch (e) { console.error('DB init failed:', e); }
    if (!SILENT_LOGS) console.log('Calling bot.launch()...');
    await bot.launch();
    if (!SILENT_LOGS) console.log('Bot launched.');
    try {
      const me = await bot.telegram.getMe();
      if (!SILENT_LOGS) console.log('Bot identity:', me.username, '(id:', me.id + ')');
    } catch (meErr) {
      if (!SILENT_LOGS) console.warn('Could not fetch bot identity with getMe():', meErr && meErr.message ? meErr.message : meErr);
    }
  } catch (err) {
    console.error('Failed to launch bot:', err && err.stack ? err.stack : err);
    // don't exit immediately so user can see logs in some environments; still exit with failure
    process.exit(1);
  }
})();

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('SIGINT received, stopping bot...');
  bot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('SIGTERM received, stopping bot...');
  bot.stop('SIGTERM');
  process.exit(0);
});
