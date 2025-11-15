/**
 * API Route: Update Transaction
 * PATCH /api/transactions/[id]
 * 
 * Updates a transaction's analysis tracking fields.
 * Used by analyst agent to mark transactions as analyzed.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { analyzed_at, analyzed_version, analysis_notes } = body;

    // Update the transaction
    await prisma.tranasctions.update({
      where: { id },
      data: {
        analyzed_at: analyzed_at ? new Date(analyzed_at) : null,
        analyzed_version: analyzed_version || null,
        analysis_notes: analysis_notes || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Transaction analysis fields updated",
    });
  } catch (error) {
    console.error("[transactions-patch] Failed to update transaction:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update transaction",
      },
      { status: 500 },
    );
  }
}
