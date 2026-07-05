FROM node:22-bookworm-slim

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=7860

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

EXPOSE 7860

CMD ["npm", "start"]
