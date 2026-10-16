FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 80

# Запускаем через sh -c, чтобы подставить $HOST_IP в Vite конфиг на лету
# Vite читает env только с префиксом VITE_ В МОМЕНТ СТАРТА сервера (define: { 'import.meta.env.VITE_API_URL': JSON.stringify(...) }) 
# НО: Vite Dev Server читает .env файлы при старте. Проще сгенерировать .env.local перед стартом.
CMD sh -c "echo 'VITE_API_URL=http://${HOST_IP}:3000' > .env.local && npm run dev -- --host 0.0.0.0 --port 80"