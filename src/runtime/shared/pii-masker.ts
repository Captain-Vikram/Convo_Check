/**
 * PII Masking Utility
 * 
 * Masks personally identifiable information in logs and output to comply
 * with DPDP Act 2023 and data protection regulations.
 */

export class PIIMasker {
  private static readonly PATTERNS = {
    // Indian phone numbers (10 digits)
    phone: /\b\d{10}\b/g,
    
    // UPI IDs (format: name@bank or phone@upi)
    upiId: /\b[\w.-]+@[\w.-]+\b/g,
    
    // Currency amounts (₹ symbol or INR)
    amount: /₹\s?\d+(?:,\d+)*(?:\.\d+)?/g,
    amountINR: /INR\s?\d+(?:,\d+)*(?:\.\d+)?/gi,
    
    // PAN card (format: ABCDE1234F)
    pan: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    
    // Aadhaar number (12 digits, sometimes with spaces/dashes)
    aadhaar: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    
    // Account numbers (8-18 digits)
    accountNumber: /\b\d{8,18}\b/g,
    
    // Card numbers (13-19 digits, sometimes with spaces/dashes)
    cardNumber: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4,7}\b/g,
    
    // IFSC codes (format: ABCD0123456)
    ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    
    // Email addresses
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  };

  /**
   * Mask all PII in SMS message content
   */
  static maskSMS(text: string): string {
    if (!text) return text;
    
    let masked = text;
    
    // Mask in order of specificity (most specific first)
    masked = masked
      .replace(this.PATTERNS.cardNumber, '****-****-****-****')
      .replace(this.PATTERNS.aadhaar, '****-****-****')
      .replace(this.PATTERNS.accountNumber, '**ACCOUNT**')
      .replace(this.PATTERNS.ifsc, '**IFSC**')
      .replace(this.PATTERNS.pan, '**PAN**')
      .replace(this.PATTERNS.phone, '**PHONE**')
      .replace(this.PATTERNS.upiId, '**UPI_ID**')
      .replace(this.PATTERNS.email, '**EMAIL**')
      .replace(this.PATTERNS.amount, '₹***')
      .replace(this.PATTERNS.amountINR, 'INR***');
    
    return masked;
  }

  /**
   * Mask phone number (show first 4 digits)
   */
  static maskPhone(phone: string): string {
    if (!phone || phone.length < 6) return '****';
    return phone.slice(0, 4) + '****';
  }

  /**
   * Mask UPI ID (show only domain)
   */
  static maskUPI(upiId: string): string {
    if (!upiId || !upiId.includes('@')) return '**UPI_ID**';
    const [, domain] = upiId.split('@');
    return `***@${domain}`;
  }

  /**
   * Mask transaction amount (show only currency)
   */
  static maskAmount(amount: number, currency: string): string {
    return `${currency} ***`;
  }

  /**
   * Mask target party name (show first 3 chars)
   */
  static maskPartyName(name: string): string {
    if (!name || name.length < 4) return '***';
    return name.slice(0, 3) + '***';
  }

  /**
   * Create a safe log object with masked PII
   */
  static createSafeLogObject(obj: Record<string, any>): Record<string, any> {
    const safe: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // Check if key suggests PII content
      const lowerKey = key.toLowerCase();
      
      if (lowerKey.includes('message') || lowerKey.includes('text') || lowerKey.includes('content')) {
        safe[key] = typeof value === 'string' ? this.maskSMS(value) : value;
      } else if (lowerKey.includes('phone') || lowerKey.includes('mobile')) {
        safe[key] = typeof value === 'string' ? this.maskPhone(value) : value;
      } else if (lowerKey.includes('upi')) {
        safe[key] = typeof value === 'string' ? this.maskUPI(value) : value;
      } else if (lowerKey.includes('amount') && typeof value === 'number') {
        safe[key] = '***';
      } else if (lowerKey.includes('party') || lowerKey.includes('payee')) {
        safe[key] = typeof value === 'string' ? this.maskPartyName(value) : value;
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        safe[key] = this.createSafeLogObject(value);
      } else {
        safe[key] = value;
      }
    }
    
    return safe;
  }

  /**
   * Check if text contains potential PII
   */
  static containsPII(text: string): boolean {
    if (!text) return false;
    
    return Object.values(this.PATTERNS).some(pattern => pattern.test(text));
  }

  /**
   * Tokenize sensitive data for storage (one-way hash)
   */
  static tokenize(data: string, salt: string = 'default-salt'): string {
    const crypto = require('node:crypto');
    return crypto
      .createHash('sha256')
      .update(data + salt)
      .digest('hex')
      .slice(0, 16);
  }
}
