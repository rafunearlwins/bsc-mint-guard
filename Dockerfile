# bsc-mint-guard — Hugging Face Spaces (Docker SDK) / generic container
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 7860
CMD ["node", "scripts/server.mjs", "7860"]
