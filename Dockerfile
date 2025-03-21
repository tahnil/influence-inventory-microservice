FROM node:18

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy all application files
COPY . .

# Create a volume for generated CSV files
VOLUME /app/data

# Expose the port your app runs on
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]