const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静的ファイル（HTMLとか置く）
app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  socket.on("chat", (msg) => {
    console.log("受信:", msg);
    io.emit("chat", msg); // 全員に送る
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("http://localhost:3000 起動中");
});