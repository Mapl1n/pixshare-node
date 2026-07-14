# PixShare Node.js 版

自建信令服务器 + P2P 直传。不依赖任何外部服务。

## 使用方法

### 1. 安装
```bash
cd pixshare-node
npm install
```

### 2. 启动
```bash
npm start
# 或
node server.js
```

终端会显示局域网地址，如 `http://192.168.1.39:8080`

### 3. 使用

**同一 WiFi 下：**
- 发送方浏览器打开 `http://192.168.1.39:8080`
- 接收方浏览器打开同一个地址
- 双方输入相同 6 位数字 → 建立 P2P → 传图

**不同网络（公网访问）：**
安装 ngrok 或 localtunnel 暴露端口：
```bash
npx localtunnel --port 8080
# 或
ngrok http 8080
```
把公网 URL 发给好友即可。

## 优势
- 零外部依赖（不需要 GitHub Pages、不需要公共 MQTT Broker）
- WebSocket 信令在自己电脑上，不受网络限制
- 同一 WiFi 下极速连接
- 26KB 单页面，瞬间加载
