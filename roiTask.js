// roiTask.js

// Dependencies
const admin = require('firebase-admin');
const dayjs = require('dayjs');

// --- Firebase Admin SDK Initialization ---

// TEMPORARY DEBUGGING LINE: This will log the raw value of the environment variable.
// This is crucial for verifying what Render is actually providing to the script.
console.log('DEBUG: Raw FIREBASE_SERVICE_ACCOUNT_KEY from process.env:', process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// Get the service account key from an environment variable set on Render.com.
// This line correctly parses the JSON string from the environment variable.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept', // Ensure this is your correct Firebase project ID
});

console.log('✅ Firebase Admin Initialized');

const db = admin.firestore();

// --- Main ROI Task Logic ---
async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    const snapshot = await db.collection('INVESTMENT').get();
    console.log(`🔍 Found ${snapshot.docs.length} investment documents to process.`); // Added for clarity in logs

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const userRef = doc.ref;

      const plan = user.activePlan;

      // ✅ Skip if no plan or not active
      if (!plan?.isActive || !plan?.status || plan?.status !== 'active') {
        console.log(`⏭️ Skipping user ${doc.id} - plan is not active or status is not 'active'. Current status: ${plan?.status || 'undefined'}.`);
        continue; // Move to the next document
      }

      // ✅ Only run if less than 7 days completed (meaning days 0 through 6)
      if (plan.daysCompleted < 7) {
        // Assuming plan.roiPercent is a decimal (e.g., 0.04 for 4%)
        // If plan.roiPercent is an integer (e.g., 4 for 4%), change 'plan.roiPercent' to '(plan.roiPercent / 100)'
        const roiAmount = plan.amount * plan.roiPercent;
        const today = dayjs().format('YYYY-MM-DD');

        // ✅ Prepare updates for Firestore
        const updates = {
          walletBal: admin.firestore.FieldValue.increment(roiAmount),
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
          }),
        };

        // ✅ Mark plan as inactive and completed if this update makes it 7 days or more
        // This means the plan completes *after* the 7th day's payout is applied.
        if (plan.daysCompleted + 1 >= 7) {
          updates['activePlan.isActive'] = false;
          updates['activePlan.status'] = 'completed';
          console.log(`🎉 Plan for user ${doc.id} completed after ${plan.daysCompleted + 1} days and marked inactive.`);
        }

        await userRef.update(updates); // Apply the updates to the user's document

        console.log(`✅ Paid ${roiAmount} to user ${doc.id} (Plan: ${plan.planName}). New days completed: ${plan.daysCompleted + 1}.`);
      } else {
        // Plan has already completed 7 days or more
        console.log(`🛑 Skipping user ${doc.id} - plan already completed ${plan.daysCompleted} days.`);

        // Optional: Ensure inactive status if it's already over 7 days but still active (for data consistency)
        if (plan.isActive || plan.status === 'active') {
           await userRef.update({
             'activePlan.isActive': false,
             'activePlan.status': 'completed'
           });
           console.log(`⚠️ Marked user ${doc.id}'s plan as completed due to daysCompleted >= 7 (data consistency check).`);
        }
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
    // Log the full error stack for more in-depth debugging if a runtime error occurs
    console.error('❌ ROI Task failed (full error details):', err);
  }
}

// --- Script Execution Trigger ---
// This function is called immediately when the Node.js script starts.
// Render's cron job service will execute this script at your defined schedule.
runRoiTaskNow();

// --- Note on 'node-cron' ---
// The 'node-cron' library (commented out below) is typically used for
// scheduling tasks *within* a long-running Node.js server process.
// Since Render handles the scheduling externally for its Cron Job services,
// this line is not used and remains commented out.
// cron.schedule('0 2 * * *', runRoiTaskNow);