import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolDefinition } from "../agents/types";

export const financialCalculatorToolDefinition: ToolDefinition = {
  name: "financial_calculator",
  description:
    "Perform accurate financial calculations for budgeting, investments, and loans. Use this tool whenever you need to calculate numbers, splits, or projections. Supports: 'budget_split' (50/30/20 rule), 'sip_calculator' (investment growth), 'loan_emi' (monthly payments).",
  parameters: [
    {
      name: "type",
      type: "string",
      description: "Type of calculation: 'budget_split' | 'sip_calculator' | 'loan_emi'",
      required: true,
    },
    {
      name: "amount",
      type: "number",
      description: "Principal amount, Income, or Monthly Investment",
      required: true,
    },
    {
      name: "rate",
      type: "number",
      description: "Interest rate (annual %) or Expected Return",
      required: false,
    },
    {
      name: "period",
      type: "number",
      description: "Time period in years (for SIP) or months (for EMI)",
      required: false,
    },
  ],
};

export interface CalculationResult {
  type: string;
  result: Record<string, number | string>;
  summary: string;
}

export function calculateBudgetSplit(income: number): CalculationResult {
  const needs = Math.round(income * 0.5);
  const wants = Math.round(income * 0.3);
  const savings = Math.round(income * 0.2);
  
  return {
    type: "budget_split",
    result: { needs, wants, savings },
    summary: `Based on the 50/30/20 rule for an income of ₹${income}: Needs: ₹${needs}, Wants: ₹${wants}, Savings: ₹${savings}.`,
  };
}

export function calculateSIP(monthlyAmount: number, rate: number, years: number): CalculationResult {
  const monthlyRate = rate / 12 / 100;
  const months = years * 12;
  const investedAmount = monthlyAmount * months;
  
  // FV = P * [ (1+i)^n - 1 ] * (1+i) / i
  const futureValue = monthlyAmount * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate) * (1 + monthlyRate);
  
  return {
    type: "sip_calculator",
    result: {
      investedAmount: Math.round(investedAmount),
      estimatedReturns: Math.round(futureValue - investedAmount),
      totalValue: Math.round(futureValue),
    },
    summary: `Investing ₹${monthlyAmount}/month for ${years} years at ${rate}% will grow to approx ₹${Math.round(futureValue).toLocaleString('en-IN')}. (Invested: ₹${investedAmount.toLocaleString('en-IN')})`,
  };
}

export function calculateEMI(principal: number, rate: number, months: number): CalculationResult {
  const r = rate / 12 / 100;
  const emi = principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
  const totalPayment = emi * months;
  
  return {
    type: "loan_emi",
    result: {
      emi: Math.round(emi),
      totalInterest: Math.round(totalPayment - principal),
      totalPayment: Math.round(totalPayment),
    },
    summary: `For a loan of ₹${principal} at ${rate}% for ${months} months, the EMI is ₹${Math.round(emi).toLocaleString('en-IN')}. Total Interest: ₹${Math.round(totalPayment - principal).toLocaleString('en-IN')}.`,
  };
}

export function createFinancialCalculatorTool() {
  const schema = z.object({
    type: z.enum(["budget_split", "sip_calculator", "loan_emi"]).describe("Type of calculation"),
    amount: z.number().describe("Principal amount, Income, or Monthly Investment"),
    rate: z.number().optional().describe("Interest rate (annual %) or Expected Return"),
    period: z.number().optional().describe("Time period in years (for SIP) or months (for EMI)"),
  });

  const createTool = tool as unknown as (options: {
    name: string;
    description: string;
    parameters: typeof schema;
    execute: (params: { type: string; amount: number; rate?: number; period?: number }) => Promise<string>;
  }) => Tool;

  return createTool({
    name: financialCalculatorToolDefinition.name,
    description: financialCalculatorToolDefinition.description,
    parameters: schema,
    execute: async ({ type, amount, rate = 12, period = 12 }) => {
      let res: CalculationResult;
      switch (type) {
        case "budget_split":
          res = calculateBudgetSplit(amount);
          break;
        case "sip_calculator":
          res = calculateSIP(amount, rate, period);
          break;
        case "loan_emi":
          res = calculateEMI(amount, rate, period);
          break;
        default:
          return `Error: Unknown calculation type: ${type}`;
      }
      return JSON.stringify(res);
    },
  });
}
