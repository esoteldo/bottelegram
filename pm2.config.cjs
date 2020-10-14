module.exports = {
  apps : [{
    name            : "sellSignals",
    script          : "./sellBot.js",
    interpreter     : "node",
    interpreterArgs : "--experimental-modules",
    watch           : false,
  }],
};
