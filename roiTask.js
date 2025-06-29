// roiTask.js

// const cron = require('node-cron'); // This line is not needed if Render schedules directly
const admin = require('firebase-admin');
const dayjs = require('dayjs');

// --- THIS IS THE CRITICAL CHANGE ---
// Get the service account key from an environment variable set on Render.com
// This replaces 'require('./serviceAccountKey.json');'
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
// --- END OF CRITICAL CHANGE ---

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept',
});

console.log('✅ Firebase Admin Initialized');

const db = admin.firestore();

async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    const snapshot = await db.collection('INVESTMENT').get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const userRef = doc.ref;

      const plan = user.activePlan;

      // ✅ Skip if no plan or not active
      if (!plan?.isActive || !plan?.status || plan?.status !== 'active') {
        console.log(`⏭️ Skipping ${doc.id} - plan is not active`);
        continue;
      }

      // ✅ Only run if less than 7 days completed
      if (plan.daysCompleted < 7) {
        // Ensure plan.roiPercent is a number (e.g., 0.04 for 4%)
        // If it's stored as an integer (e.g., 4 for 4%), you might need to divide by 100
        const roiAmount = plan.amount * (plan.roiPercent / 100); // Assuming roiPercent is like 4, not 0.04
        const today = dayjs().format('YYYY-MM-DD');

        // ✅ Calculate updates
        const updates = {
          walletBal: admin.firestore.FieldValue.increment(roiAmount),
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
          }),
        };

        // ✅ Mark plan as inactive and completed after day 7
        // If plan.daysCompleted is 0-indexed, and it should run for 7 full days (day 0 to day 6),
        // and then complete AFTER the 7th day's payout, this logic is correct.
        // It means after daysCompleted becomes 6, on the next run, it becomes 7, and then the plan is marked inactive.
        if (plan.daysCompleted + 1 >= 7) {
          updates['activePlan.isActive'] = false;
          updates['activePlan.status'] = 'completed';
          console.log(`🎉 Plan for ${doc.id} completed after 7 days.`);
        }

        await userRef.update(updates);

        console.log(`✅ Paid ${roiAmount} to ${doc.id} (${plan.planName})`);
      } else {
        console.log(`🛑 Skipping ${doc.id} - already completed 7 days or more.`);
        // Optional: Ensure inactive status if it's already over 7 days but still active (data inconsistency)
        if (plan.isActive || plan.status === 'active') {
           await userRef.update({
             'activePlan.isActive': false,
             'activePlan.status': 'completed'
           });
           console.log(`⚠️ Marked ${doc.id} as completed due to daysCompleted >= 7.`);
        }
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
  }
}

// Run immediately (manual testing for Render's cron job trigger)
runRoiTaskNow();

// The node-cron schedule is NOT used when Render directly runs 'node roiTask.js'
// cron.schedule('0 2 * * *', runRoiTaskNow);