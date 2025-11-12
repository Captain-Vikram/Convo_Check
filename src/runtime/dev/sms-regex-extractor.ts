/**
 * Regex-based SMS Transaction Extractor (Fallback)
 * 
 * Provides rule-based extraction when LLM is unavailable.
 * Handles common Indian payment SMS patterns from banks and UPI apps.
 */

import type { DevExtraction } from "./dev-llm-parser.js";

interface SMSPattern {
  regex: RegExp;
  type: "debit" | "credit";
  amountGroup: number;
  merchantGroup?: number;
  upiGroup?: number;
  accountGroup?: number;
}

// Common patterns for Indian bank/UPI SMS
const SMS_PATTERNS: SMSPattern[] = [
  // UPI debit: "Rs 500.00 debited from A/c XX1234 to merchant@upi"
  {
    regex: /(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)\s+(?:debited|debit|sent).*?(?:to|vpa)\s+([a-zA-Z0-9._-]+@[a-zA-Z]+)/i,
    type: "debit",
    amountGroup: 1,
    merchantGroup: 2,
  },
  // UPI credit: "Rs 1000 credited to your account from sender@upi"
  {
    regex: /(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)\s+(?:credited|credit|received).*?from\s+([a-zA-Z0-9._-]+@[a-zA-Z]+)/i,
    type: "credit",
    amountGroup: 1,
    merchantGroup: 2,
  },
  // Generic debit: "Amt Rs 250.50 debited from A/c XX5678"
  {
    regex: /(?:amt|amount)\s+(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)\s+(?:debited|debit)/i,
    type: "debit",
    amountGroup: 1,
  },
  // Generic credit: "Amt Rs 1500 credited to A/c"
  {
    regex: /(?:amt|amount)\s+(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)\s+(?:credited|credit)/i,
    type: "credit",
    amountGroup: 1,
  },
  // ATM withdrawal: "ATM Cash Withdrawal Rs 2000"
  {
    regex: /atm.*?(?:withdrawal|withdraw).*?(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)/i,
    type: "debit",
    amountGroup: 1,
  },
  // Card purchase: "Card XX1234 used for Rs 350 at MERCHANT NAME"
  {
    regex: /card\s+\w+\s+used.*?(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)\s+at\s+([a-zA-Z0-9\s]+?)(?:\son\s|\.|$)/i,
    type: "debit",
    amountGroup: 1,
    merchantGroup: 2,
  },
  // Salary credit: "Salary credited Rs 50000"
  {
    regex: /(?:salary|sal)\s+(?:credited|credit).*?(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)/i,
    type: "credit",
    amountGroup: 1,
  },
  // NEFT/IMPS: "NEFT-CR Rs 5000 from SENDER NAME"
  {
    regex: /(?:neft|imps|rtgs)-?(?:cr|credit).*?(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)/i,
    type: "credit",
    amountGroup: 1,
  },
  // NEFT/IMPS debit
  {
    regex: /(?:neft|imps|rtgs)-?(?:dr|debit).*?(?:rs\.?|inr)\s*(\d+(?:,\d+)*(?:\.\d{2})?)/i,
    type: "debit",
    amountGroup: 1,
  },
];

/**
 * Extract transaction from SMS using regex patterns
 */
export function extractWithRegex(message: string, timestamp?: number): DevExtraction | null {
  const cleanedMessage = message.trim();
  
  for (const pattern of SMS_PATTERNS) {
    const match = cleanedMessage.match(pattern.regex);
    if (!match) continue;
    
    // Extract amount (safely handle undefined)
    const amountStr = match[pattern.amountGroup]?.replace(/,/g, "");
    if (!amountStr) continue;
    
    const amount = Number.parseFloat(amountStr);
    if (Number.isNaN(amount) || amount <= 0) continue;
    
    // Extract merchant/UPI if available
    let targetParty: string | undefined;
    if (pattern.merchantGroup && match[pattern.merchantGroup]) {
      targetParty = match[pattern.merchantGroup]?.trim();
    }
    
    // Determine category based on keywords
    const category = categorizeFromKeywords(cleanedMessage, targetParty);
    
    // Build extraction result matching DevExtraction schema
    const extraction: DevExtraction = {
      amount,
      type: pattern.type,
      targetParty: targetParty || "Unknown",
      currency: "INR",
      medium: determineMedium(cleanedMessage),
      category,
      description: cleanedMessage.substring(0, 100), // First 100 chars as description
      date_of_transaction: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
    };
    
    return extraction;
  }
  
  return null;
}

/**
 * Determine payment medium from message
 */
function determineMedium(message: string): "upi" | "card" | "bank" | "other" {
  const lower = message.toLowerCase();
  
  if (/@|upi|paytm|phonepe|gpay|bhim/i.test(lower)) {
    return "upi";
  }
  
  if (/card|visa|mastercard|rupay/i.test(lower)) {
    return "card";
  }
  
  if (/neft|imps|rtgs|account|a\/c/i.test(lower)) {
    return "bank";
  }
  
  return "other";
}

/**
 * Categorize transaction based on keywords in message
 */
function categorizeFromKeywords(message: string, merchant?: string): string {
  const lower = message.toLowerCase();
  const merchantLower = merchant?.toLowerCase() || "";
  
  // Food & Dining
  if (
    /zomato|swiggy|food|restaurant|cafe|coffee|pizza|burger/i.test(lower) ||
    /zomato|swiggy/i.test(merchantLower)
  ) {
    return "Food & Dining";
  }
  
  // Transportation
  if (
    /uber|ola|rapido|petrol|fuel|parking|toll|metro|bus|taxi|cab/i.test(lower) ||
    /uber|ola|rapido/i.test(merchantLower)
  ) {
    return "Transportation";
  }
  
  // Shopping
  if (
    /amazon|flipkart|shop|mall|store|purchase|buy|myntra|ajio/i.test(lower) ||
    /amazon|flipkart|myntra/i.test(merchantLower)
  ) {
    return "Shopping";
  }
  
  // Utilities
  if (/electricity|water|gas|bill|recharge|mobile|internet|broadband/i.test(lower)) {
    return "Utilities";
  }
  
  // Entertainment
  if (/movie|cinema|netflix|hotstar|prime|spotify|gaming|game/i.test(lower)) {
    return "Entertainment";
  }
  
  // Healthcare
  if (/hospital|doctor|pharmacy|medicine|clinic|health/i.test(lower)) {
    return "Healthcare";
  }
  
  // ATM/Cash
  if (/atm|cash|withdrawal/i.test(lower)) {
    return "ATM & Cash";
  }
  
  // Salary/Income
  if (/salary|sal|wage|income|payment received/i.test(lower)) {
    return "Income";
  }
  
  // Transfer
  if (/transfer|sent to|neft|imps|rtgs/i.test(lower)) {
    return "Transfer";
  }
  
  return "Other";
}

/**
 * Extract multiple transactions from a batch of SMS messages
 */
export function extractBatchWithRegex(messages: Array<{ message: string; timestamp?: number }>): DevExtraction[] {
  const extractions: DevExtraction[] = [];
  
  for (const msg of messages) {
    const extraction = extractWithRegex(msg.message, msg.timestamp);
    if (extraction) {
      extractions.push(extraction);
    }
  }
  
  return extractions;
}
