"use strict";
const { getConnectionStatus } = require("../lib/connection_status");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(getConnectionStatus());
};
