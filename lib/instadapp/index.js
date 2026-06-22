const client = require("./client");
const constants = require("./constants");
const spells = require("./spells");
const tokens = require("./tokens");
const protocols = require("./protocols");
const flashloan = require("./flashloan");
const quoter = require("./quoter");
const spellBuilder = require("./spellBuilder");
const scanner = require("./scanner");
const gas = require("./gas");

module.exports = {
  ...client,
  ...constants,
  ...spells,
  ...tokens,
  ...protocols,
  ...flashloan,
  ...quoter,
  ...spellBuilder,
  ...scanner,
  ...gas,
};
