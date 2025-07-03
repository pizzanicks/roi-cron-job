// roiTask.js

// Dependencies
const admin = require('firebase-admin');
const dayjs = require('dayjs');

// --- Firebase Admin SDK Initialization ---

let serviceAccount;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_KEY is not set in environment variables!');
  }

  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  console.log("✅ Firebase service account loaded successfully.");
} catch (error) {
  console.error("❌ Failed to load Firebase service account:", error.message);
  process.exit(1); // Exit the script to prevent errors later
}

console.log('🚀 Starting ROI Cron Script...');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'rosnept',
});

console.log('✅ Firebase Admin Initialized');

const db = admin.firestore();

// --- Main ROI Task Logic ---
async function runRoiTaskNow() {
  console.log('🏁 Running Daily ROI Task...');

  try {
    const snapshot = await db.collection('INVESTMENT').get();
    console.log(`🔍 Found ${snapshot.docs.length} investment documents to process.`);

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const userRef = doc.ref;
      const plan = user.activePlan;

      if (!plan?.isActive || plan.status !== 'active') {
        console.log(`⏭️ Skipping user ${doc.id} - plan inactive or not 'active'. Status: ${plan?.status || 'undefined'}.`);
        continue;
      }

      if (plan.daysCompleted < 7) {
        const roiAmount = plan.amount * (plan.roiPercent || 0); // ensure fallback
        const today = dayjs().format('YYYY-MM-DD');

        const updates = {
          walletBal: admin.firestore.FieldValue.increment(roiAmount),
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
          }),
        };

        if (plan.daysCompleted + 1 >= 7) {
          updates['activePlan.isActive'] = false;
          updates['activePlan.status'] = 'completed';
          console.log(`🎉 Plan for user ${doc.id} completed and marked inactive.`);
        }

        await userRef.update(updates);
        console.log(`✅ Paid ${roiAmount} to user ${doc.id} (Plan: ${plan.planName || 'Unnamed'}). Days: ${plan.daysCompleted + 1}`);
      } else {
        console.log(`🛑 Skipping user ${doc.id} - plan already completed ${plan.daysCompleted} days.`);

        if (plan.isActive || plan.status === 'active') {
          await userRef.update({
            'activePlan.isActive': false,
            'activePlan.status': 'completed'
          });
          console.log(`⚠️ Auto-marked user ${doc.id}'s plan as completed (data consistency fix).`);
        }
      }
    }

    console.log('✅ ROI Task Complete');
  } catch (err) {
    console.error('❌ ROI Task failed:', err.message);
    console.error('❌ Full error details:', err);
  }
}

// --- Trigger Script ---
runRoiTaskNow();
