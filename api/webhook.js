const { buffer } = require('micro');
const express = require('express');
// Require the main bot file; it will register handlers but not launch when required
const appModule = require('../index.js');
const bot = appModule.bot;

let webhookSet = false;

module.exports = async (req, res) => {
  try {
    if (!webhookSet && process.env.WEBHOOK_URL) {
      try {
        await bot.telegram.setWebhook(process.env.WEBHOOK_URL);
        webhookSet = true;
        console.log('Webhook set to', process.env.WEBHOOK_URL);
      } catch (e) {
        console.error('Failed to set webhook:', e);
      }
    }

    if (req.method !== 'POST') {
      res.statusCode = 200;
      res.end('OK');
      return;
    }

    // Parse raw body (Vercel provides parsed body, but ensure we have it)
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString() || '{}';
        const update = JSON.parse(raw);
        await bot.handleUpdate(update);
        res.statusCode = 200;
        res.end('OK');
      } catch (e) {
        console.error('Webhook handler error:', e);
        res.statusCode = 500;
        res.end('Error');
      }
    });
  } catch (e) {
    console.error('Unexpected webhook error:', e);
    res.statusCode = 500;
    res.end('Error');
  }
};
