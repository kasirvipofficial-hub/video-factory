import pino from 'pino';
import { ENV } from '../config/env';

export const log = pino(
    {
        level: ENV.LOG_LEVEL,
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                singleLine: false,
            },
        },
    }
);
