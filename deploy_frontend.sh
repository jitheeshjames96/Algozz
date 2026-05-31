#!/bin/bash
# deploy_frontend.sh - Deploy swing-trading-app frontend to Vercel from EC2

# Exit immediately if a command exits with a non-zero status
set -e

# Change directory to where the script is located
cd "$(dirname "$0")"

echo "🔄 Pulling latest changes from GitHub..."
git pull

echo "📦 Installing node dependencies..."
npm install

echo "🧪 Running static TypeScript compilation check..."
npx tsc --noEmit

echo "🚀 Deploying to Vercel Production..."
vercel --prod --yes

echo "✅ Frontend deployment completed successfully!"
