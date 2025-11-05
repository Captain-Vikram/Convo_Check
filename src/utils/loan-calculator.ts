export interface LoanScenario {
  tenureYears: number;
  emi: number;
  totalInterest: number;
  affordabilityRatio: number;
}

const DEFAULT_INTEREST = 8.5; // Annual percentage rate (APR)

export function calculateLoanAmount(
  propertyPrice: number,
  downPaymentPercent: number,
  currentSavings: number,
): number {
  if (propertyPrice <= 0) {
    return 0;
  }

  const downPaymentAmount = propertyPrice * (downPaymentPercent / 100);
  const loanNeeded = propertyPrice - downPaymentAmount - currentSavings;
  return Math.max(0, Math.round(loanNeeded));
}

export function calculateEMI(
  principal: number,
  annualRatePercent: number,
  tenureYears: number,
): number {
  if (principal <= 0 || tenureYears <= 0) {
    return 0;
  }

  const monthlyRate = annualRatePercent / 12 / 100;
  const totalMonths = tenureYears * 12;

  if (monthlyRate === 0) {
    return Math.round(principal / totalMonths);
  }

  const factor = Math.pow(1 + monthlyRate, totalMonths);
  const emi = principal * monthlyRate * factor / (factor - 1);
  return Math.round(emi / 100) * 100; // Round to nearest ₹100 for clarity
}

export function calculateTotalInterest(
  principal: number,
  annualRatePercent: number,
  tenureYears: number,
): number {
  if (principal <= 0 || tenureYears <= 0) {
    return 0;
  }

  const emi = calculateEMI(principal, annualRatePercent, tenureYears);
  const totalPaid = emi * tenureYears * 12;
  const interest = totalPaid - principal;
  return Math.max(0, Math.round(interest / 100) * 100);
}

export function buildLoanScenarios(
  principal: number,
  annualRatePercent: number = DEFAULT_INTEREST,
  tenureOptions: number[] = [15, 20, 25, 30],
  monthlyIncome: number | undefined,
): LoanScenario[] {
  return tenureOptions.map((tenure) => {
    const emi = calculateEMI(principal, annualRatePercent, tenure);
    const totalInterest = calculateTotalInterest(principal, annualRatePercent, tenure);
    const affordabilityRatio = monthlyIncome && monthlyIncome > 0 ? emi / monthlyIncome : 0;
    return { tenureYears: tenure, emi, totalInterest, affordabilityRatio };
  });
}

export function pickAffordableScenario(
  scenarios: LoanScenario[],
  affordabilityCeiling: number,
): LoanScenario | undefined {
  return scenarios.find((scenario) => scenario.affordabilityRatio > 0 && scenario.affordabilityRatio <= affordabilityCeiling);
}

export function estimateStampDutyBuffer(propertyPrice: number): number {
  return Math.round(propertyPrice * 0.09); // 9% midpoint of the 8-10% range
}

export function formatRupees(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}
