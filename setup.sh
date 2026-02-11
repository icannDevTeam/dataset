#!/bin/bash

# Quick setup script for web-dataset-collector
# Usage: bash setup.sh

echo "🚀 Setting up Facial Attendance Web Dataset Collector..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install from https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js found: $(node --version)"

# Create .env.local from template
if [ ! -f ".env.local" ]; then
    echo ""
    echo "📝 Creating .env.local from template..."
    cp .env.example .env.local
    echo "✅ Created .env.local"
    echo ""
    echo "⚠️  IMPORTANT: Edit .env.local with your credentials:"
    echo "   - API_KEY: Your Binus School API key"
    echo "   - Firebase configuration (project ID, private key, etc.)"
    echo ""
else
    echo "✅ .env.local already exists"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "✅ Setup complete!"
echo ""
echo "🎯 Next steps:"
echo "1. Edit .env.local with your API credentials"
echo "2. Run: npm run dev"
echo "3. Open http://localhost:3000"
echo ""
echo "📖 For more info, see README.md"
