const client = require("./client");
const keys = require("./keys");
const constants = require("./constants");
const spells = require("./spells");
const tokens = require("./tokens");
const protocols = require("./protocols");
const flashloan = require("./flashloan");
const quoter = require("./quoter");
const spellBuilder = require("./spellBuilder");
const scanner = require("./scanner");
const gas = require("./gas");
const avocadoWallet = require("./avocadoWallet");

module.exports = {
  ...client,
  ...keys,
  ...constants,
  ...spells,
  ...tokens,
  ...protocols,
  ...flashloan,
  ...quoter,
  ...spellBuilder,
  ...scanner,
  ...gas,
  ...avocadoWallet,
};
