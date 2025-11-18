# ============================================================================
# Convo_Check API Feature Test Suite
# Tests all available API endpoints and agent features
# ============================================================================

$BaseUrl = "http://localhost:3000"
$UserId = "2"
$DevToken = $env:DEV_AUTH_TOKEN

if (-not $DevToken) {
    Write-Host "WARNING: DEV_AUTH_TOKEN not set. Using default token." -ForegroundColor Yellow
    $DevToken = "test-token-123"
}

$Headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $DevToken"
}

$TestResults = @{
    Passed = 0
    Failed = 0
    Skipped = 0
}

function Write-TestHeader {
    param([string]$Title)
    Write-Host "`n========================================================" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
}

function Test-Endpoint {
    param(
        [string]$Name,
        [string]$Url,
        [string]$Method = "GET",
        [object]$Body = $null,
        [hashtable]$CustomHeaders = $Headers
    )
    
    Write-Host "`nTEST: $Name" -ForegroundColor Yellow
    Write-Host "   URL: $Method $Url" -ForegroundColor Gray
    
    try {
        $params = @{
            Uri = $Url
            Method = $Method
            Headers = $CustomHeaders
            TimeoutSec = 30
        }
        
        if ($Body -and $Method -ne "GET") {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
            Write-Host "   Body: $($params.Body)" -ForegroundColor Gray
        }
        
        $response = Invoke-RestMethod @params
        Write-Host "   SUCCESS" -ForegroundColor Green
        
        if ($response) {
            Write-Host "   Response:" -ForegroundColor Gray
            $responseJson = $response | ConvertTo-Json -Depth 3 -Compress
            if ($responseJson.Length -gt 200) {
                Write-Host "   $($responseJson.Substring(0, 200))..." -ForegroundColor DarkGray
            } else {
                Write-Host "   $responseJson" -ForegroundColor DarkGray
            }
        }
        
        $TestResults.Passed++
        return $response
    }
    catch {
        Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) {
            Write-Host "   Details: $($_.ErrorDetails.Message)" -ForegroundColor DarkRed
        }
        $TestResults.Failed++
        return $null
    }
}

function Test-AgentConversation {
    param(
        [string]$AgentName,
        [string]$Message,
        [string]$ExpectedKeyword = ""
    )
    
    $body = @{
        userId = $UserId
        message = $Message
    }
    
    $response = Test-Endpoint -Name "$AgentName Agent: '$Message'" -Url "$BaseUrl/api/agent" -Method "POST" -Body $body
    
    $matched = $false
    if ($response -and $ExpectedKeyword) {
        if ($response.message) {
            $matched = $response.message -match $ExpectedKeyword
        }
    }
    if ($matched) {
        Write-Host "   OK Response contains expected keyword: ""$ExpectedKeyword""" -ForegroundColor Green
    } elseif ($response -and $ExpectedKeyword) {
        Write-Host "   WARNING Response missing expected keyword: ""$ExpectedKeyword""" -ForegroundColor Yellow
    }
    
    return $response
}

# ============================================================================
# START TESTS
# ============================================================================

Write-Host "`n=========================================================" -ForegroundColor Magenta
Write-Host "║  Convo_Check API Feature Test Suite                       ║" -ForegroundColor Magenta
Write-Host "║  Testing all available endpoints and agent features       ║" -ForegroundColor Magenta
Write-Host "=========================================================" -ForegroundColor Magenta

# ============================================================================
# 1. SMS INGESTION & PROCESSING (Dev Agent)
# ============================================================================

Write-TestHeader "1. SMS INGESTION `& PROCESSING (Dev Agent)"

# Test SMS ingestion
$smsBody = @{
    userPhone = "919619183585"
    smsBody = "You have spent Rs 1250 at AMAZON on 15-Nov-2025. Available balance: Rs 45,320. -HDFC Bank"
    receivedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

Test-Endpoint `
    -Name "SMS Ingestion" `
    -Url "$BaseUrl/api/sms/ingest" `
    -Method "POST" `
    -Body $smsBody

Start-Sleep -Seconds 1

# Test SMS processing queue
Test-Endpoint `
    -Name "SMS Queue Processing" `
    -Url "$BaseUrl/api/sms/process-queue" `
    -Method "POST"

# ============================================================================
# 2. MILL AGENT - Transaction Logging & Queries
# ============================================================================

Write-TestHeader "2. MILL AGENT - Transaction Logging `& Queries"

Test-AgentConversation `
    -AgentName "Mill" `
    -Message "I spent 250 rupees on groceries today" `
    -ExpectedKeyword "transaction"

Start-Sleep -Seconds 1

Test-AgentConversation `
    -AgentName "Mill" `
    -Message "What did I spend yesterday?" `
    -ExpectedKeyword ""

Start-Sleep -Seconds 1

Test-AgentConversation `
    -AgentName "Mill" `
    -Message "Show me my total spending this month" `
    -ExpectedKeyword ""

# ============================================================================
# 3. CHATUR AGENT - Financial Coaching
# ============================================================================

Write-TestHeader "3. CHATUR AGENT - Financial Coaching"

Test-AgentConversation `
    -AgentName "Chatur" `
    -Message "How can I save more money?" `
    -ExpectedKeyword "save"

Start-Sleep -Seconds 1

Test-AgentConversation `
    -AgentName "Chatur" `
    -Message "Give me tips to reduce my food expenses" `
    -ExpectedKeyword ""

Start-Sleep -Seconds 1

Test-AgentConversation `
    -AgentName "Chatur" `
    -Message "Help me create a budget" `
    -ExpectedKeyword "budget"

# ============================================================================
# 4. PARAM AGENT - Analyst Auto-Run
# ============================================================================

Write-TestHeader "4. PARAM AGENT - Financial Analysis"

Test-Endpoint `
    -Name "Analyst Auto-Run (Habit Analysis)" `
    -Url "$BaseUrl/api/analyst/auto-run" `
    -Method "POST"

# ============================================================================
# 5. SERA AGENT - Shopping Assistant (if configured)
# ============================================================================

Write-TestHeader "5. SERA AGENT - Shopping Assistant"

Test-AgentConversation `
    -AgentName "Sera" `
    -Message "I want to buy a laptop under 50000 rupees" `
    -ExpectedKeyword ""

# ============================================================================
# 6. WISHLIST MANAGEMENT
# ============================================================================

Write-TestHeader "6. WISHLIST MANAGEMENT"

# Add item to wishlist
$wishlistItem = @{
    name = "Test Laptop"
    url = "https://example.com/laptop"
    currentPrice = 45000
    targetPrice = 40000
    currency = "INR"
    priority = "high"
}

$addedItem = Test-Endpoint `
    -Name "Add Wishlist Item" `
    -Url "$BaseUrl/api/wishlist" `
    -Method "POST" `
    -Body $wishlistItem

Start-Sleep -Seconds 1

# Get all wishlist items
$wishlistItems = Test-Endpoint `
    -Name "Get Wishlist Items" `
    -Url "$BaseUrl/api/wishlist?limit=10" `
    -Method "GET"

Start-Sleep -Seconds 1

# Update wishlist item (if one was created)
if ($addedItem -and $addedItem.id) {
    $updateBody = @{
        currentPrice = 43000
        notes = "Price dropped by 2000!"
    }
    
    Test-Endpoint `
        -Name "Update Wishlist Item" `
        -Url "$BaseUrl/api/wishlist/$($addedItem.id)" `
        -Method "PATCH" `
        -Body $updateBody
    
    Start-Sleep -Seconds 1
    
    # Delete wishlist item
    Test-Endpoint `
        -Name "Delete Wishlist Item" `
        -Url "$BaseUrl/api/wishlist/$($addedItem.id)" `
        -Method "DELETE"
}

# ============================================================================
# 7. GROUNDED SEARCH (if configured)
# ============================================================================

Write-TestHeader "7. GROUNDED SEARCH"

$searchBody = @{
    query = "best budget smartphones in India"
    num = 5
}

Test-Endpoint `
    -Name "Grounded Search" `
    -Url "$BaseUrl/api/grounded-search" `
    -Method "POST" `
    -Body $searchBody

# ============================================================================
# 8. MILL PROXY (Direct Mill Agent Access)
# ============================================================================

Write-TestHeader "8. MILL PROXY - Direct Access"

$millProxyBody = @{
    userId = $UserId
    message = "Log transaction: coffee 150 rupees"
}

Test-Endpoint `
    -Name "Mill Proxy Direct Call" `
    -Url "$BaseUrl/api/mill-proxy" `
    -Method "POST" `
    -Body $millProxyBody

# ============================================================================
# 9. CONVERSATION CONTINUITY TESTS
# ============================================================================

Write-TestHeader "9. CONVERSATION CONTINUITY"

$sessionId = $null

# Start conversation
$response1 = Test-AgentConversation `
    -AgentName "Mill" `
    -Message "I spent 500 on dinner"

if ($response1 -and $response1.sessionId) {
    $sessionId = $response1.sessionId
    Write-Host "   Session ID: $sessionId" -ForegroundColor Cyan
}

Start-Sleep -Seconds 1

# Continue conversation (should remember context)
Test-AgentConversation `
    -AgentName "Mill" `
    -Message "Actually, make that 550"

# ============================================================================
# 10. ERROR HANDLING TESTS
# ============================================================================

Write-TestHeader "10. ERROR HANDLING"

# Test with missing required fields
$invalidBody = @{
    # Missing userId
    message = "test"
}

Write-Host "`n🧪 Testing: Invalid Request (Missing userId)" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod `
        -Uri "$BaseUrl/api/agent" `
        -Method "POST" `
        -Headers $Headers `
        -Body ($invalidBody | ConvertTo-Json) `
        -ErrorAction Stop
    Write-Host "   ⚠️  UNEXPECTED: Request should have failed" -ForegroundColor Yellow
} catch {
    Write-Host "   ✅ Expected error caught: $($_.Exception.Message)" -ForegroundColor Green
    $TestResults.Passed++
}

# Test protected endpoint without auth
$noAuthHeaders = @{ "Content-Type" = "application/json" }

Write-Host "`n🧪 Testing: Protected Endpoint Without Auth" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod `
        -Uri "$BaseUrl/api/protected" `
        -Method "GET" `
        -Headers $noAuthHeaders `
        -ErrorAction Stop
    Write-Host "   ⚠️  UNEXPECTED: Should require authentication" -ForegroundColor Yellow
} catch {
    Write-Host "   ✅ Expected auth error: $($_.Exception.Message)" -ForegroundColor Green
    $TestResults.Passed++
}

# ============================================================================
# TEST SUMMARY
# ============================================================================

Write-Host "`n╔════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║  TEST SUMMARY                                              ║" -ForegroundColor Magenta
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta

$total = $TestResults.Passed + $TestResults.Failed + $TestResults.Skipped

Write-Host "`n📊 Results:" -ForegroundColor Cyan
Write-Host "   Total Tests:  $total" -ForegroundColor White
Write-Host "   ✅ Passed:    $($TestResults.Passed)" -ForegroundColor Green
Write-Host "   ❌ Failed:    $($TestResults.Failed)" -ForegroundColor Red
Write-Host "   ⏭️  Skipped:   $($TestResults.Skipped)" -ForegroundColor Yellow

$successRate = if ($total -gt 0) { [math]::Round(($TestResults.Passed / $total) * 100, 1) } else { 0 }
Write-Host "`n   Success Rate: $successRate%" -ForegroundColor $(if ($successRate -ge 80) { "Green" } elseif ($successRate -ge 50) { "Yellow" } else { "Red" })

if ($TestResults.Failed -eq 0) {
    Write-Host "`nALL TESTS PASSED!" -ForegroundColor Green
} elseif ($TestResults.Failed -le 3) {
    Write-Host "`nSOME TESTS FAILED. Check the details above." -ForegroundColor Yellow
} else {
    Write-Host "`nMULTIPLE TEST FAILURES DETECTED. Please review the output." -ForegroundColor Red
}

Write-Host "`n========================================================`n" -ForegroundColor Magenta

# Return exit code based on failures
exit $TestResults.Failed
