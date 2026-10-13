-- CreateTable
CREATE TABLE "UserCart" (
    "userId" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCart_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UserWishlist" (
    "userId" TEXT NOT NULL,
    "productIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserWishlist_pkey" PRIMARY KEY ("userId")
);