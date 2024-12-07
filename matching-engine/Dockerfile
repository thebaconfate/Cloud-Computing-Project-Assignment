# Use command: docker build -t <tagname> .

FROM node:20.15

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

ENTRYPOINT ["node", "main.js" ]
