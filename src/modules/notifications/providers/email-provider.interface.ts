export interface SendEmailInput {
  to: string;
  subject: string;
  textContent: string;
}

export interface SendEmailResult {
  providerMessageId: string;
}

export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
