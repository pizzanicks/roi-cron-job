// roiTask.js

const admin = require('firebase-admin');
const dayjs = require('dayjs');

// --- Firebase Admin SDK Initialization ---
let serviceAccount;

try {
  const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
  console.log('DEBUG: Raw FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 from process.env:', serviceAccountBase64 ? 'Value is present' : 'Value is undefined/empty');

  if (!serviceAccountBase64) {
    throw new Error('❌ FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 environment variable is not set or is empty!');
  }

  serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
  console.log("✅ Firebase service account loaded successfully from Base64.");
} catch (error) {
  console.error("❌ Failed to load Firebase service account:", error.message);
  console.error("❌ Full error details during service account loading:", error);
  process.exit(1);
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
      const investmentDocData = doc.data(); // This is the INVESTMENT document's data
      const investmentDocRef = doc.ref;
      const plan = investmentDocData.activePlan;

      // --- NEW: Get the associated userId from the INVESTMENT document ---
      const userId = investmentDocData.userId; // Assuming 'userId' field exists in INVESTMENT documents
      if (!userId) {
        console.warn(`⚠️ Skipping investment ${doc.id} - No userId found in the document.`);
        continue; // Skip if no user ID is linked
      }
      const userProfileRef = db.collection('USERS').doc(userId); // Reference to the actual USER document

      if (!plan?.isActive || plan.status !== 'active' || plan.action === 'paused' || plan.action === 'stopped') {
        console.log(`⏸️ Skipping user ${userId} (Investment: ${doc.id}) - Plan is not active or paused/stopped. Status: ${plan?.status}, Action: ${plan?.action}`);
        continue;
      }

      if (plan.daysCompleted < 7) { // Assuming 7 days is the plan duration
        const roiAmount = plan.amount * (plan.roiPercent || 0);
        const today = dayjs().format('YYYY-MM-DD');
        const newDaysCompleted = plan.daysCompleted + 1;

        // --- Updates for the INVESTMENT document ---
        const investmentUpdates = {
          'activePlan.daysCompleted': admin.firestore.FieldValue.increment(1),
          payoutLogs: admin.firestore.FieldValue.arrayUnion({
            date: today,
            amount: roiAmount,
            status: 'paid',
          }),
        };

        // --- Updates for the USER'S PROFILE (USERS collection) ---
        const userProfileUpdates = {
          walletBalance: admin.firestore.FieldValue.increment(roiAmount), // Increment user's wallet
          // These fields will reflect the current active plan's status on the user's profile
          currentPlanDaysCompleted: newDaysCompleted,
          currentPlanRoiPercentage: plan.roiPercent || 0,
          lastRoiPaymentDate: today, // Optional: add a timestamp for last payment
        };

        if (newDaysCompleted >= 7) {
          if (plan.action === 'restart') {
            investmentUpdates['activePlan.daysCompleted'] = 0;
            investmentUpdates['activePlan.status'] = 'active';
            investmentUpdates['activePlan.isActive'] = true;
            investmentUpdates['activePlan.action'] = 'active';
            console.log(`🔁 Restarted plan for user ${userId} (Investment: ${doc.id})`);

            // Also reset user profile fields if the plan restarts
            userProfileUpdates.currentPlanDaysCompleted = 0; // Reset for user profile
            // userProfileUpdates.currentPlanRoiPercentage remains the same for the new cycle
          } else {
            investmentUpdates['activePlan.isActive'] = false;
            investmentUpdates['activePlan.status'] = 'completed';
            console.log(`🎉 Plan for user ${userId} (Investment: ${doc.id}) completed and marked inactive.`);

            // Mark user profile plan details as completed/inactive
            userProfileUpdates.currentPlanDaysCompleted = newDaysCompleted; // Final days
            userProfileUpdates.currentPlanRoiPercentage = plan.roiPercent || 0; // Final ROI
            userProfileUpdates.isInvestmentActive = false; // Add a field to user profile for overall investment status
          }
        }

        // Perform updates on both documents
        await investmentDocRef.update(investmentUpdates); // Update INVESTMENT document
        await userProfileRef.update(userProfileUpdates); // Update USERS document

        console.log(`✅ Paid $${roiAmount.toFixed(2)} to user ${userId} (Plan: ${plan.planName || 'Unnamed'}). Days: ${newDaysCompleted}`);
      } else {
        console.log(`🛑 Skipping user ${userId} (Investment: ${doc.id}) - plan already completed ${plan.daysCompleted} days.`);

        if (plan.isActive || plan.status === 'active') {
          // This ensures consistency for plans already past 7 days but still marked active
          await investmentDocRef.update({
            'activePlan.isActive': false,
            'activePlan.status': 'completed'
          });
          // Also update user profile if their active plan is now completed
          await userProfileRef.update({
            isInvestmentActive: false,
            currentPlanDaysCompleted: plan.daysCompleted, // Final days count
          });
          console.log(`⚠️ Auto-marked user ${userId}'s plan (Investment: ${doc.id}) as completed and updated user profile.`);
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