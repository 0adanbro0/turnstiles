FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 80

# Запускаем Vite и заставляем его слушать все сетевые интерфейсы (0.0.0.0)
# Это критически важно, чтобы порт "пробросился" из контейнера на пк
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "80"]