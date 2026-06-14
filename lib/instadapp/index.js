const client = require("./client");
const constants = require("./constants");
const spells = require("./spells");

module.exports = {
  ...client,
  ...constants,
  ...spells,
};
