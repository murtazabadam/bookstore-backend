/*
  Warnings:

  - You are about to drop the column `shippingInfo` on the `StoreSettings` table. All the data in the column will be lost.
  - You are about to drop the column `supportEmail` on the `StoreSettings` table. All the data in the column will be lost.
  - You are about to drop the column `supportPhone` on the `StoreSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "razorpayPaymentId" TEXT,
ADD COLUMN     "shippingCharge" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StoreSettings" DROP COLUMN "shippingInfo",
DROP COLUMN "supportEmail",
DROP COLUMN "supportPhone",
ADD COLUMN     "adminAlertEmail" TEXT,
ADD COLUMN     "codEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "courierName" TEXT,
ADD COLUMN     "deliveryEstimate" TEXT,
ADD COLUMN     "freeShippingThreshold" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "logoUrl" TEXT,
ADD COLUMN     "lowStockThreshold" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "onlinePaymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "replyToEmail" TEXT,
ADD COLUMN     "senderName" TEXT,
ADD COLUMN     "shippingCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "storeEmail" TEXT,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "trackingUrlTemplate" TEXT;
