require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');

// Load environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SEARCH_ENGINE_ID = process.env.SEARCH_ENGINE_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
bot.setWebHook(`https://ualbot.onrender.com/${TELEGRAM_BOT_TOKEN}`);

// Webhook setup
const app = express();
app.use(express.json());

app.post(`/${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot is listening on port ${PORT}`));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// MongoDB Connection
mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("Connected to MongoDB!"))
    .catch(err => console.error("MongoDB connection error:", err));

const userSchema = new mongoose.Schema({
    chat_id: Number,
    first_name: String,
    username: String,
    phone_number: String,
});

const chatSchema = new mongoose.Schema({
    chat_id: Number,
    user_input: String,
    bot_response: String,
    timestamp: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);
const Chat = mongoose.model("Chat", chatSchema);

// Handle /start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.chat.first_name;
    const username = msg.chat.username;

    let user = await User.findOne({ chat_id: chatId });
    if (!user) {
        user = new User({ chat_id: chatId, first_name: firstName, username: username });
        await user.save();
        bot.sendMessage(chatId, `Welcome, ${firstName}! You can ask me anything.`);
        bot.sendMessage(chatId, `Please share your phone number by clicking the button below.`, {
            reply_markup: {
                keyboard: [[{ text: "Share Phone Number", request_contact: true }]],
                one_time_keyboard: true
            }
        });
    } else {
        bot.sendMessage(chatId, `Welcome back, ${firstName}! Ask me anything.`);
    }
});

// Handle phone number submission
bot.on("contact", async (msg) => {
    const chatId = msg.chat.id;
    const phoneNumber = msg.contact.phone_number;

    await User.updateOne({ chat_id: chatId }, { phone_number: phoneNumber });
    bot.sendMessage(chatId, "Phone number saved! You can now start chatting.");
});

// Handle user queries using Gemini AI
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: text }] }]
        });

        const response = result.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't understand that.";

        await new Chat({ chat_id: chatId, user_input: text, bot_response: response }).save();
        bot.sendMessage(chatId, response);
    } catch (error) {
        console.error("Error generating content:", error.message, error.stack);
        bot.sendMessage(chatId, "Sorry, I couldn't process your request.");
    }
});

// Handle web search
bot.onText(/\/websearch (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const query = match[1];

    try {
        const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
            params: { q: query, key: GOOGLE_API_KEY, cx: SEARCH_ENGINE_ID }
        });

        const searchResults = response.data.items.slice(0, 3)
            .map(item => `${item.title}\n${item.link}`)
            .join('\n\n');

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: `Summarize this: ${searchResults}` }] }]
        });

        const summary = result.candidates?.[0]?.content?.parts?.[0]?.text || "No summary available.";

        await new Chat({ chat_id: chatId, user_input: query, bot_response: summary }).save();
        bot.sendMessage(chatId, `🔍 Search Results:\n\n${searchResults}\n\n📝 Summary:\n${summary}`);
    } catch (error) {
        console.error('Error fetching search results:', error.message);
        bot.sendMessage(chatId, 'Error fetching search results.');
    }
});

// Handle image analysis
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    try {
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

        const mimeType = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";

        const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
        const base64Image = Buffer.from(response.data).toString("base64");

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

        const result = await model.generateContent({
            contents: [
                { role: "user", parts: [{ inlineData: { data: base64Image, mimeType: mimeType } }, { text: "Describe this image briefly." }] }
            ]
        });

        const description = result.candidates?.[0]?.content?.parts?.[0]?.text || "No description available.";

        await new Chat({ chat_id: chatId, user_input: "image", bot_response: description }).save();
        bot.sendMessage(chatId, `🖼 Image Analysis: ${description}`);
    } catch (error) {
        console.error("Error analyzing image:", error);
        bot.sendMessage(chatId, "Error analyzing the image.");
    }
});

console.log("Bot is running...");
