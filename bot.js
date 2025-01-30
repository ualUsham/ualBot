require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Load environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SEARCH_ENGINE_ID= process.env.SEARCH_ENGINE_ID;
const GOOGLE_API_KEY=process.env.GOOGLE_API_KEY;

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Initialize Google Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// MongoDB Local Connection Setup
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 10000, 
}).then(() => {
  console.log("Connected to MongoDB!");
}).catch(err => {
  console.error("MongoDB connection error:", err);
});

// Define MongoDB Schemas i.e structure of documents
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

//creating mongodb collection
const User = mongoose.model("User", userSchema);
const Chat = mongoose.model("Chat", chatSchema);

// Handle Start & Registration
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.chat.first_name;
  const username = msg.chat.username;

  let user = await User.findOne({ chat_id: chatId });
  if (!user) {
    user = new User({ chat_id: chatId, first_name: firstName, username: username });
    await user.save();
    bot.sendMessage(chatId, `Welcome, ${firstName}! You can ask questions to this bot. Feel free to drop any questions here`)
    bot.sendMessage(chatId, `To continue chatting, please share your Phone Number by clicking the button next to the typing area.`, {
      reply_markup: {
        keyboard: [[{ text: "Share Phone Number", request_contact: true }]],
        one_time_keyboard: true
      }
    });
  } else {
    bot.sendMessage(chatId, `Welcome back ${firstName}! Please ask a question. I will be happy to assist you!!`);
  }
});

// Handle phone number submission
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const phoneNumber = msg.contact.phone_number;

  await User.updateOne({ chat_id: chatId }, { phone_number: phoneNumber });
  bot.sendMessage(chatId, "Phone number saved successfully! Now you can start asking questions.", {
    reply_markup: {
      keyboard: [[{ text: "", request_contact: false }]],
      one_time_keyboard: false
    }
  }); //false so that request phn number gets hidden after saved
});

//handle help for user
bot.onText(/\/help/,(msg)=>{
  const chatId=msg.chat.id
  bot.sendMessage(chatId,"This bot can perform the following tasks: \n 1. Enter /start to start the bot. \n 2. Type any question to ask. \n 3. Send an image for analysis. \n 4. Before your questions, if you include /websearch you will get top 3 results from the web and their summary. ")
});

// Handle Gemini-powered chat
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && text.startsWith("/start")) return;
  if (text && text.startsWith("/websearch")) return;
  if (!text) return;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: text }] }]
    });

    const response = result.response.text();
    // save the response to MongoDB
    await new Chat({ chat_id: chatId, user_input: text, bot_response: response }).save();
    // send response to user 
    bot.sendMessage(chatId, response);
    
  } catch (error) {
    console.error("Error generating content:", error);
    bot.sendMessage(chatId, "Sorry, I couldn't process your request. Please try again later.");
  }
});
  

// Handle web search
bot.onText(/\/websearch (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  try {
    // Fetch search results
    const response = await axios.get('https://www.googleapis.com/customsearch/v1', {
      params: {
        q: query,
        key: GOOGLE_API_KEY,
        cx: SEARCH_ENGINE_ID,
      },
    });
    const searchResults = response.data.items.slice(0, 3).map(item => `${item.title}\n${item.link}`).join('\n\n');

    // Generate summary using Gemini API
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const prompt = `Summarize the following search results:\n\n${searchResults}`;
    const result = await model.generateContent(prompt);
    const summary = result.response.text();

    // save the response to MongoDB
    await new Chat({ chat_id: chatId, user_input: query, bot_response: summary }).save();

    // Send message to user
    bot.sendMessage(chatId, `🔍 Top search results:\n\n${searchResults}\n\n📝 Summary:\n\n${summary}`);
  } catch (error) {
    console.error('Error fetching search results:', error.response ? error.response.data : error.message);
    bot.sendMessage(chatId, 'Error fetching search results.');
  }
});


// Handle image/file analysis
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
      // Get the file URL from Telegram
      const file = await bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      
      //for different image formats
      let mimeType = "image/jpeg"; 
      if (file.file_path.endsWith(".png")) mimeType = "image/png";
      else if (file.file_path.endsWith(".webp")) mimeType = "image/webp";

      // Download the image and convert to base64 format
      const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const base64Image = Buffer.from(response.data).toString("base64");

      // Initialize Gemini AI model
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
      
      // Send the image for analysis
      const result = await model.generateContent([
          {
              inlineData: {
                  data: base64Image,
                  mimeType: mimeType, 
              },
          },
          "Describe this image in brief.",
      ]);

      const description = result.response.text();
      //save the response to mongodb
      await new Chat({ chat_id: chatId, user_input:"image", bot_response: description }).save();
      // Send the response back to Telegram
      bot.sendMessage(chatId, `🖼 Image Analysis: ${description}`);
  } catch (error) {
      console.error("Error analyzing image:", error);
      bot.sendMessage(chatId, "Error analyzing the image.");
  }
});

console.log("Bot is running...");

