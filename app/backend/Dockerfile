FROM node:18-alpine

WORKDIR /app

# для того, чтобы не происходила перерисовка всего проекта при изменениях
COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]