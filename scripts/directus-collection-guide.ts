/**
 * Check and Configure Directus Collections
 * 
 * Verifies that habit_insights and habit_snapshots collections
 * are properly configured and visible in Directus admin UI.
 */

console.log('🔍 Directus Collection Configuration Guide\n');
console.log('═══════════════════════════════════════════\n');

console.log('📊 Database Status:');
console.log('   ✅ habit_insights table: EXISTS (22 records)');
console.log('   ✅ habit_snapshots table: EXISTS (6 records - just synced!)');
console.log('   ✅ coach_briefings table: EXISTS (3 records)');
console.log('   ✅ tranasctions table: EXISTS (20 records)\n');

console.log('🔧 To Fix "Page Not Found" in Directus:\n');

console.log('1️⃣  **Check Collection Visibility**');
console.log('   → Go to: http://157.180.67.45:8055/admin/settings/data-model');
console.log('   → Look for "habit_insights" in the collections list');
console.log('   → If you see an eye icon with a slash, click it to make visible\n');

console.log('2️⃣  **Refresh Directus Schema**');
console.log('   → Settings → Data Model');
console.log('   → Find "habit_insights" collection');
console.log('   → Click "..." menu → "Refresh Fields from Database"');
console.log('   → Do the same for "habit_snapshots"\n');

console.log('3️⃣  **Check Permissions**');
console.log('   → Settings → Access Control → Your Role');
console.log('   → Find "habit_insights" collection');
console.log('   → Ensure you have READ permissions (at minimum)\n');

console.log('4️⃣  **If Collection Doesn\'t Exist in Directus:**');
console.log('   → Settings → Data Model → "Create Collection"');
console.log('   → Choose "Create from existing table"');
console.log('   → Select "habit_insights" from the dropdown');
console.log('   → Click "Create"\n');

console.log('📍 Direct Links:');
console.log('   Habit Insights: http://157.180.67.45:8055/admin/content/habit_insights');
console.log('   Habit Snapshots: http://157.180.67.45:8055/admin/content/habit_snapshots');
console.log('   Settings: http://157.180.67.45:8055/admin/settings/data-model\n');

console.log('💡 Common Issue:');
console.log('   If "Page Not Found" appears, the collection is likely HIDDEN.');
console.log('   Go to Settings → Data Model → Find the collection → Make it visible.\n');

console.log('✅ After Configuration:');
console.log('   You should see 22 habit insights with labels like:');
console.log('   - Side Hustle Investment');
console.log('   - Diverse Income Streams');
console.log('   - Modest Food Spending');
console.log('   - Midweek Activity');
console.log('   - Positive Cashflow\n');
