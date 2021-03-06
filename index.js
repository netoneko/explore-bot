'use strict';

const Promise = require('bluebird'),
  _ = require('lodash'),
  fs = require('fs'),
  request = require('request'),
  get = Promise.promisify(request.get),
  TelegramBot = require('node-telegram-bot-api'),
  qs = require('querystring'),
  Redis = require('ioredis'),
  API_URL = "https://api.foursquare.com/v2/venues/explore?";

const getResults = (options, credentials) => {
  const url = API_URL + qs.stringify(_.extend(options, credentials));
  return get(url).get('body').then(JSON.parse);
};

const getAnswers = (data) => {
  return _.get(data, 'response.groups[0].items');
};

const formatAnswer = (venue, index) => {
  const address = _.get(venue, 'location.address', 'Exact address unspecified');
  return `/venue${index + 1} ${venue.name}, ${address}`;
};

const getFromRedis = (redis, id, field) => {
  return new Promise((resolve, reject) => {
    redis.hgetall(`users:${id}`, (error, data) => {
      if (error) {
        return reject;
      }
      try {
        resolve(JSON.parse(data[field]));
      } catch (e) {
        reject(e);
      }
    });
  });
};

const sendVenueList = (bot, id, venues) => {
  const formattedAnswers = _.map(venues, formatAnswer);
  return bot.sendMessage(id, 'Other venues:\n' + formattedAnswers.join('\n'));
};

const sendVenueLocation = (bot, config, redis, msg, match) => {
  const id = msg.chat.id,
    index = _.toInteger(match[1]),
    answers = getFromRedis(redis, id.toString(), 'answers');

  answers.then(answers => {
    const venues = _.map(answers, 'venue'),
    venue = venues[index - 1],
    tips = answers[index - 1].tips,
    openHours = _.get(venue, `hours.status`, `no info`),
    phone = _.get(venue, 'contact.phone', 'no phone'),
    category = _.get(venue, 'categories[0].name', 'no category'),
    address = _.get(venue, 'location.address', 'No address'),
    distance = _.get(venue, 'location.distance', '000');

    return Promise.all([
      bot.sendLocation(id, venue.location.lat,venue.location.lng),
      bot.sendMessage(id,
`${venue.name},
Phone: ${phone}
Category: ${category}
Open hours: ${openHours}
${address} (${distance}m)
More: /tips${index}`)
    ]).return(venues);
  }).then(_.partial(sendVenueList, bot, id));
};

const getPhoto = (url) => {
    return new Promise((resolve, reject) => {
        request(url).pipe((stream, err) => {
            err ? reject(err) : resolve(stream);
        });
    });
};

const sendVenueTips = (bot, config, redis, msg, match) => {
  const id = msg.chat.id,
    index = _.toInteger(match[1]),
    answers = getFromRedis(redis, id.toString(), 'answers'),
    venues = answers.map(a => a.venue);

    return answers.get(index - 1).get('tips').map(tip => {
        const data = [tip.text];

        if (tip.photourl) {
            data.push(get({url: tip.photourl, encoding: null}).get('body'));
        }

        return Promise.all(data);
    }).map((results) => {
        const [text, photo] = results;

        if (photo) {
            return bot.sendPhoto(id, photo, {caption: text});
        } else {
            return bot.sendMessage(id, text);
        }
    }).return(venues).then(_.partial(sendVenueList, bot, id));
};

const onLocation = (bot, config, redis, msg) => {
  const id = msg.chat.id,
    ll = msg.location.latitude + ',' + msg.location.longitude,
    limit = 3,
    v = 20160820,
    section = "food",
    options = {limit, ll, section, v};

  getResults(options, config.foursquare_credentials)
    .then(getAnswers).tap(answers => {
      redis.hmset(`users:${id}`, {answers: JSON.stringify(answers)});
    }).map((a, i) => formatAnswer(a.venue, i)).then(formattedAnswers => {
      bot.sendMessage(id, formattedAnswers.join('\n'));
    }).catch(err => {
      bot.sendMessage(id, err.toString());
    });
};

const processMessages = (bot, config, redis) => {
  redis.lpop('messages').then(JSON.parse).then((msg) =>{
    const next = _.partial(processMessages, bot, config, redis);

    if (!_.isEmpty(msg)) {
      console.log(msg);
      if (msg.location) {
        onLocation(bot, config, redis, msg);
      } else if (msg.text) {
        let match;

        if (match = msg.text.match(/\/venue(\d+)/)){
          sendVenueLocation(bot, config, redis, msg, match);
      } else if (match = msg.text.match(/\/tips(\d+)/)){
          sendVenueTips(bot, config, redis, msg, match);
        }

        console.log(match);
      }

      next();
    } else {
      setTimeout(next, 200);
    }
    });
};

const start = (config, isWorker) => {
  const bot = new TelegramBot(config.token, {polling: !isWorker}),
    redis = new Redis(config.redis_url);

    console.log("Polling: " + !isWorker);
  if (isWorker) {
    processMessages(bot, config, redis);
  } else {
    bot.on('message', msg => {redis.lpush(`messages`, JSON.stringify(msg))})
  }

  console.log('Up, up and away!');
};

const getConfig = () => {
  try {
    console.log('Trying TEST config')
    return require('./config.json')
  } catch (e) {
    console.log('Failed. We\'re going LIVE!');
    return {
      "token": process.env.TELEGRAM_TOKEN,
      "foursquare_credentials": {
        "client_id": process.env.FOURSQUARE_CLIENT_ID,
        "client_secret": process.env.FOURSQUARE_SECRET
      },
      "redis_url": process.env.REDIS_URL
    }
  }
};


if (!module.parent) {
  start(getConfig(), !_.isEmpty(process.env.WORKER));
}

module.exports.formatAnswer = formatAnswer;
