-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('TRAVEL', 'OFFICE', 'ENTERTAIN', 'TRANSPORT', 'OTHER');

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "applicant" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_items" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "spentOn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expenses_code_key" ON "expenses"("code");

-- CreateIndex
CREATE INDEX "expenses_submittedAt_idx" ON "expenses"("submittedAt" DESC);

-- CreateIndex
CREATE INDEX "expenses_status_idx" ON "expenses"("status");

-- CreateIndex
CREATE INDEX "expense_items_expenseId_idx" ON "expense_items"("expenseId");

-- AddForeignKey
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
