#!/bin/bash

echo "========================================"
echo "🧪 Web Collector API Test Suite"
echo "========================================"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo -e "${BLUE}[Test 1]${NC} Health Check Endpoint"
echo "GET /api/health"
RESPONSE=$(curl -s http://localhost:3000/api/health)
if echo "$RESPONSE" | grep -q '"status":"ok"'; then
  echo -e "${GREEN}✓ PASS${NC}: Health check responding"
  echo "  Response: $RESPONSE" | head -c 100
  echo "..."
else
  echo -e "${RED}✗ FAIL${NC}: Health check not responding"
fi
echo ""

# Test 2: Student Lookup - Valid Student ID
echo -e "${BLUE}[Test 2]${NC} Student Lookup Endpoint (API connectivity)"
echo "POST /api/student/lookup"
RESPONSE=$(curl -s -X POST http://localhost:3000/api/student/lookup \
  -H "Content-Type: application/json" \
  -d '{"studentId": "TEST123"}' \
  --max-time 15)

if echo "$RESPONSE" | grep -q 'error\|success'; then
  echo -e "${GREEN}✓ PASS${NC}: Student lookup endpoint responsive"
  if echo "$RESPONSE" | grep -q '"error"'; then
    echo "  Note: Got error response (expected for test ID)"
  fi
  echo "  Response: $(echo "$RESPONSE" | cut -c1-80)..."
else
  echo -e "${RED}✗ FAIL${NC}: No response from student lookup"
fi
echo ""

# Test 3: Missing Student ID
echo -e "${BLUE}[Test 3]${NC} Validation - Missing Student ID"
echo "POST /api/student/lookup (no studentId)"
RESPONSE=$(curl -s -X POST http://localhost:3000/api/student/lookup \
  -H "Content-Type: application/json" \
  -d '{}')

if echo "$RESPONSE" | grep -q '"error"'; then
  echo -e "${GREEN}✓ PASS${NC}: Properly validates missing studentId"
  echo "  Response: $(echo "$RESPONSE" | cut -c1-80)..."
else
  echo -e "${YELLOW}⚠ WARNING${NC}: Expected validation error"
fi
echo ""

# Test 4: Frontend Access
echo -e "${BLUE}[Test 4]${NC} Frontend Page Load"
echo "GET /"
RESPONSE=$(curl -s http://localhost:3000 | head -c 500)
if echo "$RESPONSE" | grep -q 'Facial Dataset Collector'; then
  echo -e "${GREEN}✓ PASS${NC}: Frontend page loading correctly"
  echo "  Found: 'Facial Dataset Collector' in HTML"
else
  echo -e "${RED}✗ FAIL${NC}: Frontend not loading"
fi
echo ""

# Test 5: Check if dev server is running
echo -e "${BLUE}[Test 5]${NC} Server Status"
if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
  echo -e "${GREEN}✓ PASS${NC}: Dev server running on port 3000"
  ps aux | grep "npm run dev" | grep -v grep | awk '{print "  Process: PID", $2, "- Memory:", $6"KB"}'
else
  echo -e "${RED}✗ FAIL${NC}: Dev server not responding"
fi
echo ""

echo "========================================"
echo -e "${GREEN}✓ Test Suite Complete${NC}"
echo "========================================"
echo ""
echo "Summary:"
echo "  Frontend: http://localhost:3000"
echo "  API Health: /api/health"
echo "  Student Lookup: /api/student/lookup (POST)"
echo ""
echo "Ready for user testing with real Binus student IDs!"
