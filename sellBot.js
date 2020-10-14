/* eslint-disable no-async-promise-executor */
import dotenv from 'dotenv';
import asyncRedis from 'async-redis';
import Telegraf from 'telegraf';
import Markup from 'telegraf/markup.js';
import Session from 'telegraf/session.js';
import Stage from 'telegraf/stage.js';
import WizardScene from 'telegraf/scenes/wizard/index.js'
import Koa from 'koa';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import axios from 'axios';

// read sensitive data from .env file
dotenv.config();
const cryptoApi = process.env.CRYPTO_API;
const cryptoApiKey = process.env.API_KEY;
const port = process.env.TELEGRAM_BOT_PORT;
const token = process.env.TELEGRAM_BOT_TOKEN;
const webhook = process.env.TELEGRAM_WEBHOOK;
const maxRedisKeysPerScan = parseInt(process.env.MAX_REDIS_KEYS_PER_SCAN, 10);
const negativePercentageThreshold = process.env.NEGATIVE_THRESHOLD;
const positivePercentageThreshold = process.env.POSITIVE_THRESHOLD;

// initialize all objects that the app will use
const app = new Koa();
const router = new Router();
const redisClient = asyncRedis.createClient();
/**
 * TODO: extend use to any other crypto coin available
 * in the coinmarketcap API
 */
const supportedCoins = ['BTC', 'ETH', 'USDT'];

// define commands supported by our telegram Bot
/**
 * TODO: add commands to turn on/off notifications
 */
const cryptoCommands = [
  {
    command: '/status',
    description: 'show percentage of gain/loss',
  },
  {
    command: '/update',
    description: 'edit quantity and buyPrice',
  },
];
// end define commands supported by our telegram Bot

// define default messages
let helpMessage = "I can help you manage your Binance's P2P trading account\n\n";
helpMessage += 'You can control me by sending these commands:\n\n';
helpMessage += cryptoCommands.map((command) => `${command.command} - ${command.description}\n`).join('');

// define the solve question wizard for the /solvequestion bot command
const updateCoinBalance = new WizardScene(
  'update-coin-balance',
  ctx => {
    /**
     * TODO: implement coin-picker easy to use inline-menu
     */
    ctx.replyWithHTML('(Paso 1 de 3) Dame la <b>moneda</b>');
    ctx.wizard.state.coinData = {
      username: ctx.message.from.username,
    };
    return ctx.wizard.next();
  },
  async (ctx) => {
    /**
     * validate previous answer (Dame la moneda)
     */
    const coinCode = ctx.message.text;
    if (!supportedCoins.includes(coinCode)) {
      return ctx.reply('not a valid coin code');
    }
    ctx.wizard.state.coinData.coinCode = coinCode;
    // find if coin balance and buyPrice exists for this username
    let [coinBalance, coinBuyPrice] = await Promise.all([
      redisClient.hget(
        `crypto:${ctx.message.from.username}:COIN:${coinCode}`,
        'balance',
      ),
      redisClient.hget(
        `crypto:${ctx.message.from.username}:COIN:${coinCode}`,
        'buyPrice',
      )
    ]);
    coinBalance = parseFloat(coinBalance || '0.0');
    coinBuyPrice = coinBuyPrice || 'N/A';
    ctx.wizard.state.coinData.coinBalance = coinBalance;
    ctx.wizard.state.coinData.coinBuyPrice = coinBuyPrice;

    ctx.replyWithHTML(`<i><b>${
      coinCode
    }</b></i> current balance is ${
      coinBalance
    } with buy price at ${
      coinBuyPrice
    }`);
    /**
     * Next step
     */
    ctx.replyWithHTML(`(Paso 2 de 3) Escribe el nuevo balance de <i><b>${coinCode}</b></i>`);
    return ctx.wizard.next();
  },
  async (ctx) => {
    /**
     * validate previous answer (Escribe el nuevo balance)
     */
    if (Number.isNaN(parseFloat(ctx.message.text))) {
      return ctx.reply(`answer should be a number`);
    }
    ctx.wizard.state.coinData.newBalance = parseFloat(ctx.message.text);

    /**
     * Next step
     */
    ctx.replyWithHTML(`(Paso final) Escribe el precio al que compraste <i><b>${
      ctx.wizard.state.coinData.coinCode
    }</b></i>`);
    return ctx.wizard.next();
  },
  ctx => {
    /**
     * validate previous answer (Escribe el buyPrice)
     */
    if (Number.isNaN(parseFloat(ctx.message.text))) {
      return ctx.reply(`answer should be a number`);
    }
    ctx.wizard.state.coinData.buyPrice = parseFloat(ctx.message.text);

    /**
     * Display overview
     */
    let msg = '_Overview_\n\n';
    msg += `Coin: *${ctx.wizard.state.coinData.coinCode}*\n`;
    msg += `Old balance: "*${ctx.wizard.state.coinData.coinBalance}*"\n`;
    msg += `New Balance: *${ctx.wizard.state.coinData.newBalance}*\n`;
    msg += `Precio de Compra: *${ctx.wizard.state.coinData.buyPrice}*`;
    ctx.replyWithMarkdown(msg);
    ctx.reply(
      'Is this correct?',
      Markup.inlineKeyboard([
        Markup.callbackButton('✅ YES!', 'UPDATE_COIN_BALANCE_IS_CORRECT'),
        Markup.callbackButton('❌ no', 'RESET_ALL_COIN_BALANCE_DATA'),
      ]).extra(),
    );
    ctx.session.coinData = Object.assign({}, ctx.wizard.state.coinData);
    return ctx.scene.leave();
  }
);
const stage = new Stage([updateCoinBalance]);

/***********************
 * BEGIN STAGE ACTIONS *
 **********************/
stage.action('UPDATE_COIN_BALANCE_IS_CORRECT', async (ctx) => {
  if (!ctx.session.coinData) {
    ctx.reply('Operation canceled');
    return ctx.scene.leave();
  }
  // update balance and buy price
  await Promise.all([
    redisClient.hset(
      `crypto:${
        ctx.session.coinData.username
      }:COIN:${
        ctx.session.coinData.coinCode
      }`,
      'balance', ctx.session.coinData.newBalance
    ),
    redisClient.hset(
      `crypto:${
        ctx.session.coinData.username
      }:COIN:${
        ctx.session.coinData.coinCode
      }`,
      'buyPrice', ctx.session.coinData.buyPrice
    )
  ]);
  console.log(`Update ${
    ctx.session.coinData.coinCode
  } ${ctx.session.coinData.username}'s balance from ${
    ctx.session.coinData.coinBalance
  } to ${ctx.session.coinData.newBalance}, buyPrice=${
    ctx.session.coinData.buyPrice
  }`);
  ctx.reply('DONE!');
  ctx.session.coinData = undefined;
  delete ctx.session.coinData;
  return ctx.scene.leave();
});

stage.action('RESET_ALL_COIN_BALANCE_DATA', ctx => {
  ctx.reply('Operation canceled');
  ctx.session.coinData = undefined;
  delete ctx.session.coinData;
  return ctx.scene.leave();
});
/*********************
 * END STAGE ACTIONS *
 ********************/

/************************
 * BEGIN STAGE COMMANDS *
 ***********************/
stage.command('cancel', (ctx) => {
  ctx.reply('Operation canceled');
  ctx.session.coinData = undefined;
  delete ctx.session.coinData;
  return ctx.scene.leave();
});
/**********************
 * END STAGE COMMANDS *
 *********************/

// init telegraf botm, setup telegram webhook, bot session and bot stage middleares
const bot = new Telegraf(token);
bot.telegram.setWebhook(`${webhook}/${token}`);
bot.use(Session());
bot.use(stage.middleware());

/**********************
 * BEGIN BOT COMMANDS *
 *********************/
// set bot commands and replace the old ones (telegram app should be restarted)
bot.settings(async (ctx) => {
  await ctx.telegram.setMyCommands([
    ...cryptoCommands,
  ]);
  return ctx.reply('Ok');
});

// welcome the user and initialize profile on redis
bot.start(async (ctx) => {
  await redisClient.set(
    `crypto:${ctx.message.from.username}:CHAT_ID`,
    ctx.message.chat.id,
  );
  return ctx.replyWithMarkdown(helpMessage);
});

// show help menu
bot.help(async ({ replyWithMarkdown }) => replyWithMarkdown(helpMessage));

// Crypto Commands
bot.command('status', async (ctx) => {
  /**
   * TODO: optimize with only one await Promise.all() call
   */
  let [btcBalance, ethBalance, usdtBalance] = await Promise.all(
    supportedCoins.map((coinCode) => redisClient.hget(
      `crypto:${ctx.message.from.username}:COIN:${coinCode}`,
      'balance',
    ))
  );
  /**
   * TODO: use supportedCoins instead of individual coin-name variables
   */
  btcBalance = parseFloat(btcBalance || '0.0');
  ethBalance = parseFloat(ethBalance || '0.0');
  usdtBalance = parseFloat(usdtBalance || '0.0');

  /**
   * TODO: pending call updateUserThreshold()
   */
  let [btcThreshold, ethThreshold, usdtThreshold] = await Promise.all(
    supportedCoins.map((coinCode) => redisClient.hget(
      `crypto:${ctx.message.from.username}:COIN:${coinCode}`,
      'threshold',
    ))
  );
  btcThreshold = btcThreshold || '+0.0%';
  ethThreshold = ethThreshold || '+0.0%';
  usdtThreshold = usdtThreshold || '+0.0%';

  let [btcBuyPrice, ethBuyPrice, usdtBuyPrice] = await Promise.all(
    supportedCoins.map((coinCode) => redisClient.hget(
      `crypto:${ctx.message.from.username}:COIN:${coinCode}`,
      'buyPrice',
    ))
  );
  btcBuyPrice = btcBuyPrice || 'N/A';
  ethBuyPrice = ethBuyPrice || 'N/A';
  usdtBuyPrice = usdtBuyPrice || 'N/A';

  // get current market prices
  const [btcMarketPrice, ethMarketPrice, usdtMarketPrice] = (await Promise.all(
    supportedCoins.map((coinCode) => redisClient.get(`crypto:marketPrice:${coinCode}`))
  )).map((price) => parseFloat(price).toFixed(2));

  /**
   * calculate total
   */
  let total = 0;
  [btcThreshold, ethThreshold, usdtThreshold].forEach((threshold) => {
    const [mxn] = threshold.split('MXN');
    total += parseFloat(mxn);
  });

  return ctx.replyWithHTML(`${ctx.message.from.username} networth\n\nBTC Balance: <b>${
    btcBalance
  }</b>\n${btcThreshold[0] === '+' ? 'Gains' : 'Losses'}: <b>${
    btcThreshold
  }</b>\nBuy Price: <b>${
    btcBuyPrice
  }</b>\nMarket Price: <b>${
    btcMarketPrice
  }</b>\n\nETH Balance: <b>${
    ethBalance
  }</b>\n${ethThreshold[0] === '+' ? 'Gains' : 'Losses'}: <b>${
    ethThreshold
  }</b>\nBuy Price: <b>${
    ethBuyPrice
  }</b>\nMarket Price: <b>${
    ethMarketPrice
  }</b>\n\nUSDT Balance: <b>${
    usdtBalance
  }</b>\n${usdtThreshold[0] === '+' ? 'Gains' : 'Losses'}: <b>${
    usdtThreshold
  }</b>\nBuy Price: <b>${
    usdtBuyPrice
  }</b>\nMarket Price: <b>${
    usdtMarketPrice
  }</b>\n\nYOU'RE <b>${
    total >= 0 ? 'winning' : 'losing'
  }</b> ${
    total >= 0 ? '+' : ''
  }${total.toFixed(2)} MXN`);
});
bot.command('update', async (ctx) => {
  let msg = 'Soy el asistente para actualizar balances. ';
  msg += 'Puedes interrumpir el proceso en cualquier momento usando /cancel';
  ctx.reply(msg);
  // call update coin balance wizard
  return ctx.scene.enter('update-coin-balance');
});
/***********************
 * FINISH BOT COMMANDS *
 **********************/

/**************************
 * BEGIN HELPER FUNCTIONS *
 *************************/
const sendSellAlert = async (
  isPositive, username, coinCode, threshold,
) => new Promise(async (resolve, reject) => {
  const chatId = await redisClient.get(`crypto:${username}:CHAT_ID`);
  if (!chatId) {
    return reject(`not a valid username ${username}`);
  }
  let counter = await redisClient.get(`crypto:${
    isPositive ? 'positiveSignalsCounter' : 'negativeSignalsCounter'
  }`);
  counter = parseInt(counter, 10) || 0;
  await redisClient.set(`crypto:${
    isPositive ? 'positiveSignalsCounter' : 'negativeSignalsCounter'
  }`, counter + 1);
  await bot.telegram.sendMessage(
    chatId,
    `Hey ${username} <b>${
      isPositive ? 'Good news!!' : 'Bad news!'
    }</b>\nIt's time to sell your <b>${coinCode}</b> because you have ${
      isPositive ? 'gain' : 'loss'
    } ${threshold}`,
    { parse_mode: 'HTML' },
  );
  return resolve('OK');
});

const capitalGainsLoss = (
  percentagesArray, coinBuyPrice,
) => percentagesArray.map((p) => p * coinBuyPrice / 100);

const optimizedRedisScan = (
  pattern,
) => new Promise(async (resolve) => {
  const found = [];
  let cursor = '0';
  do {
    const reply = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', maxRedisKeysPerScan);
    [cursor] = reply;
    found.push(...reply[1]);
  } while (cursor !== '0');
  return resolve(found);
});
/************************
 * END HELPER FUNCTIONS *
 ***********************/

/***********************
 * BEGIN KOA ENDPOINTS *
 **********************/
router.get('/checkPrice', async (ctx) => {
  let coinMarketCapResponse;
  try {
    /**
     * TODO: retrieve data not only in MXN,
     * but in any other fiat currency supported by the
     * coinmarketcap API and customized by the user
     */
    coinMarketCapResponse = await axios({
      url: cryptoApi,
      method: 'GET',
      headers: {
        'X-CMC_PRO_API_KEY': cryptoApiKey,
      },
    });
  } catch (err) {
    console.error('API error at /checkPrice', err);
    ctx.status = 400;
    ctx.body = `API error ${err}`;
    return;
  }

  const fullCoinData = coinMarketCapResponse.data.data;
  supportedCoins.map(async (coinCode) => {
    const [coinData] = fullCoinData.filter((coinData) => coinData.symbol === coinCode);
    await redisClient.set(`crypto:marketPrice:${coinCode}`, coinData.quote.MXN.price);

    /**
     * populate allUsersCurrency
     */
    const allUsersCurrency = [];
    
    const redisKeys = await optimizedRedisScan(`crypto:*:COIN:${coinCode}`);
    const allUsersCoinQuantity = await Promise.all((redisKeys).map((key) => redisClient.hget(key, 'balance')));
    const allUsersBuyPrice = await Promise.all((redisKeys).map((key) => redisClient.hget(key, 'buyPrice')));
    
    redisKeys.forEach((key, index) => {
      const [, username] = key.split(':');
      if (allUsersCoinQuantity[index] && allUsersBuyPrice[index]) {
        allUsersCurrency.push({
          username,
          coinQuantity: parseFloat(allUsersCoinQuantity[index]),
          coinBuyPrice: parseFloat(allUsersBuyPrice[index]),
        });
      }
    });

    /**
     * check buy price for all users of this coinCode
     * and if necessary send alerts
     */
    allUsersCurrency.map(async (userCurrency) => {
      console.log('\nuserCurrency', userCurrency, coinCode);
      const diffPrices = coinData.quote.MXN.price - userCurrency.coinBuyPrice;
      /**
       * TODO: use user customized threshold percentages for this calculation
       */
      const [cg, cl, real] = capitalGainsLoss(
        [
          positivePercentageThreshold,
          negativePercentageThreshold,
          Math.abs(diffPrices) * 100 / userCurrency.coinBuyPrice,
        ],
        userCurrency.coinBuyPrice,
      );
      console.log(`+${positivePercentageThreshold}% representan +${cg} MXN. With your balance +${cg * userCurrency.coinQuantity}`);
      console.log(`-${negativePercentageThreshold}% representan -${cl} MXN. With your balance -${cl * userCurrency.coinQuantity}`);
      console.log(`${
        diffPrices >= 0 ? '+' : '-'
      }${
        Math.abs(diffPrices) * 100 / userCurrency.coinBuyPrice
      }% representan ${
        diffPrices >= 0 ? '+' : '-'
      }${real} MXN. With your balance ${
        diffPrices >= 0 ? '+' : '-'
      }${real * userCurrency.coinQuantity}`);

      /**
       * calculate threshold
       */
      const threshold = diffPrices >= 0 ? `+${
        (real * userCurrency.coinQuantity).toFixed(2)
      } MXN +${
        (Math.abs(diffPrices) * 100 / userCurrency.coinBuyPrice).toFixed(2)
      }%` : `-${
        (real * userCurrency.coinQuantity).toFixed(2)
      } MXN -${
        (Math.abs(diffPrices) * 100 / userCurrency.coinBuyPrice).toFixed(2)
      }%`;
      console.log('diffPrices', diffPrices);
      console.log('threshold', threshold);

      /**
       * TODO: pending call updateUserThreshold()
       */
      await redisClient.hset(
        `crypto:${
          userCurrency.username
        }:COIN:${
          coinCode
        }`,
        'threshold',
        threshold,
      );
      try {
        if (diffPrices >= cg) {
          await sendSellAlert(true, userCurrency.username, coinCode, threshold);
        } else if (diffPrices * -1 >= cl) {
          await sendSellAlert(false, userCurrency.username, coinCode, threshold);
        }
      } catch (err) {
        console.error('cannot sendSellAlert()', err)
      }
    });
  });
  ctx.status = 204;
});
/************************
 * FINISH KOA ENDPOINTS *
 ***********************/

// setup koa middlewares
app.use(bodyParser());
app.use(async (ctx, next) => {
  if (ctx.method !== 'POST' || ctx.url !== `/${token}`) {
    return next();
  }
  await bot.handleUpdate(ctx.request.body, ctx.response);
  ctx.status = 200;
});
app.use(router.routes());
app.use(router.allowedMethods());

// open port and start listening for requests
app.listen(port, () => console.log(`Crypto Bot 💰 listening on ${port} ...`));
