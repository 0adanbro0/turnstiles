FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

RUN npm install

COPY . .

EXPOSE 80

# listen all modules on port 0.0.0.0
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "80"]