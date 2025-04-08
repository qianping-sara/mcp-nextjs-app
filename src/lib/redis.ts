import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL environment variable is not set.");
}

// Vercel uses TLS for Redis, but ioredis might need explicit opts
// depending on the Redis provider and connection string format.
// Basic parsing to check if it's rediss:// or includes tls=true
let tlsOptions = undefined;
if (redisUrl.startsWith('rediss://') || redisUrl.includes('tls=true')) {
    // You might need to adjust TLS options based on your Redis provider
    // For example, some might require `rejectUnauthorized: false` if using self-signed certs (not recommended for prod)
    tlsOptions = { rejectUnauthorized: process.env.NODE_ENV === 'production' }; // Be stricter in production
    console.log("Attempting Redis connection with TLS enabled.");
} else {
    console.log("Attempting Redis connection without explicit TLS.");
}

const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3, // Optional: configure retry strategy
    tls: tlsOptions,
    lazyConnect: true, // Connect only when needed
});

redis.on('connect', () => {
    console.log('Connected to Redis');
});

redis.on('error', (err) => {
    console.error('Redis connection error:', err);
});

export default redis;
