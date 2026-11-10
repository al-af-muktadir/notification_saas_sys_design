import { Injectable } from '@nestjs/common';

import {
  EmailProvider,
  SendEmailInput,
  SendEmailResult,
} from './email-provider.interface.js';

export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

@Injectable()
export class BrevoEmailProvider implements EmailProvider {
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    const senderName = process.env.BREVO_SENDER_NAME ?? 'Notification SaaS';

    if (!apiKey || !senderEmail) {
      throw new EmailProviderError('Brevo configuration is missing', false);
    }

    let response: Response;

    try {
      response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender: {
            name: senderName,
            email: senderEmail,
          },
          to: [{ email: input.to }],
          subject: input.subject,
          textContent: input.textContent,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new EmailProviderError(
        `Brevo network request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }

    const responseBody = await response.text();

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;

      throw new EmailProviderError(
        `Brevo API error (${response.status}): ${responseBody}`,
        retryable,
      );
    }

    let result: { messageId?: string };

    try {
      result = JSON.parse(responseBody);
    } catch {
      throw new EmailProviderError('Brevo returned an invalid response', true);
    }

    if (!result.messageId) {
      throw new EmailProviderError('Brevo did not return a message ID', true);
    }

    return {
      providerMessageId: result.messageId,
    };
  }
}
