// Improved Influence inventory script without slot concept
import fs from 'fs';
import { starknetContracts, Entity, Product, Inventory, Building } from '@influenceth/sdk';
import { RpcProvider } from 'starknet';

// Parse command line arguments
const args = process.argv.slice(2);
const ENTITY_ID = parseInt(args[0]) || 32456; // Default entity ID
const OUTPUT_FILE = args[1] || 'warehouse-inventory.csv'; // Default output file

console.log(`
===========================================
   Influence Warehouse Inventory Query
===========================================
Entity ID: ${ENTITY_ID}
Output File: ${OUTPUT_FILE}
===========================================
`);

// Function to convert a string to a felt (field element) for Starknet
function shortStringToFelt(str) {
  return '0x' + Buffer.from(str).toString('hex');
}

// Detailed logging function for examining raw data
function detailedLog(title, data) {
  console.log(`\n=== ${title} ===`);
  console.log('Total Elements:', data.length);
  data.forEach((element, index) => {
    console.log(`[${index}]: Raw: ${element}`);
    try {
      const decimalValue = parseInt(element, 16);
      console.log(`    Decimal: ${decimalValue}`);
      
      // Attempt hex to string conversion for debugging
      if (element.startsWith('0x')) {
        const hexBuffer = Buffer.from(element.slice(2), 'hex');
        const stringAttempt = hexBuffer.toString('utf-8').replace(/[^\x20-\x7E]/g, '');
        if (stringAttempt.length > 0) {
          console.log(`    Possible String: "${stringAttempt}"`);
        }
      }
    } catch (error) {
      // Just skip if conversion fails
    }
  });
}

// Async function to make a ReadComponent call to the Starknet blockchain
async function readComponent(provider, dispatcherAddress, componentName, scope, entityKey, slot = null) {
  const systemName = shortStringToFelt("ReadComponent");
  
  // Build calldata array based on whether a slot is specified
  let calldata;
  if (slot === null) {
    calldata = [
      shortStringToFelt(componentName),
      scope.toString(),
      entityKey
    ];
  } else {
    calldata = [
      shortStringToFelt(componentName),
      scope.toString(),
      entityKey,
      slot.toString()
    ];
  }

  console.log(`Reading ${componentName} component for entity ${entityKey}${slot !== null ? ` slot ${slot}` : ''}...`);
  console.log('calldata:', calldata);
  
  try {
    const { result } = await provider.callContract({
      contractAddress: dispatcherAddress,
      entrypoint: "run_system",
      calldata: [shortStringToFelt("ReadComponent"), calldata.length.toString(), ...calldata]
    });
    
    return result;
  } catch (error) {
    console.log(`Error reading component ${componentName}: ${error.message}`);
    return null;
  }
}

// Function to parse inventory data into a structured format
function parseInventory(inventoryResult) {
  if (!inventoryResult || inventoryResult.length < 8) {
    throw new Error('Invalid inventory data returned');
  }
  
  // Log raw data extensively to help with debugging
  console.log('\n=== RAW INVENTORY DATA ANALYSIS ===');
  console.log('Total array length:', inventoryResult.length);
  
  // Skip the first two metadata elements
  const metadataOffset = 2;
  
  // Basic inventory properties with correct offset
  const inventoryType = parseInt(inventoryResult[metadataOffset], 16);
  const status = parseInt(inventoryResult[metadataOffset + 1], 16);
  const mass = BigInt(inventoryResult[metadataOffset + 2] || '0x0');
  const volume = BigInt(inventoryResult[metadataOffset + 3] || '0x0');
  const reservedMass = BigInt(inventoryResult[metadataOffset + 4] || '0x0');
  const reservedVolume = BigInt(inventoryResult[metadataOffset + 5] || '0x0');
  
  // Check if this looks like a site inventory with construction materials
  const isSiteInventory = (inventoryType === 15 || inventoryType === 1) && status > 1;
  
  // Find the contents array
  // For site inventories or regular inventories, adjust offset to account for metadata
  let contentsArrayOffset = metadataOffset + 6;
  let contentsLength = 0;
  
  // Try parsing the contents array length
  try {
    if (inventoryResult[contentsArrayOffset] && 
        inventoryResult[contentsArrayOffset].startsWith('0x')) {
      contentsLength = parseInt(inventoryResult[contentsArrayOffset], 16);
      
      // If we get a very small number like 0 or 1, and we have elements after, 
      // try an alternative offset for site inventories
      if (contentsLength <= 1 && inventoryResult.length > contentsArrayOffset + 4 && isSiteInventory) {
        contentsArrayOffset = metadataOffset + 8;
        contentsLength = parseInt(inventoryResult[contentsArrayOffset], 16);
        console.log(`Detected site inventory format, contents start at offset ${contentsArrayOffset}, length ${contentsLength}`);
      }
      
      // Limit contents length for safety during parsing
      if (contentsLength > 200) {
        console.log(`WARNING: Unusually large contents length ${contentsLength}. Limiting to 200.`);
        contentsLength = 200;
      }
    }
  } catch (error) {
    console.error(`Error parsing contents length: ${error.message}`);
    contentsLength = 0;
  }
  
  console.log(`\nParsed inventory with type ${inventoryType}, status ${status}, contents length ${contentsLength}`);
  console.log(`Contents array starts at offset ${contentsArrayOffset}`);
  
  // Parse products in the inventory
  const products = [];
  if (contentsLength > 0) {
    // Each product entry takes 2 fields: product ID and quantity
    for (let i = 0; i < contentsLength; i++) {
      const productOffset = contentsArrayOffset + 1 + (i * 2);
      if (productOffset + 1 < inventoryResult.length) {
        const productId = parseInt(inventoryResult[productOffset], 16);
        const quantity = parseInt(inventoryResult[productOffset + 1], 16);
        
        if (!isNaN(productId) && !isNaN(quantity)) {
          const productInfo = Product.TYPES[productId];
          console.log(`Found product: ${productInfo ? productInfo.name : 'Unknown'} (ID: ${productId}), Quantity: ${quantity}`);
          products.push({ productId, quantity });
        }
      }
    }
  }
  
  return {
    inventoryType,
    status,
    mass,
    volume,
    reservedMass,
    reservedVolume,
    products,
    isSiteInventory,
    rawData: inventoryResult.slice(0, Math.min(30, inventoryResult.length)) // Include raw data for reference
  };
}

// Function to get product details and save inventory to CSV
function exportInventoryToCSV(inventory, outputFile) {
  const { products } = inventory;
  
  // Handle case with no products
  if (products.length === 0) {
    console.log('No products found in inventory.');
    fs.writeFileSync(outputFile, 'Product ID,Product Name,Quantity,Mass (g),Volume (mL)\n');
    return;
  }
  
  // Create CSV header
  let csv = 'Product ID,Product Name,Quantity,Mass (g),Volume (mL)\n';
  
  // Add each product to the CSV
  products.forEach(({ productId, quantity }) => {
    const productInfo = Product.TYPES[productId];
    
    let name = 'Unknown Product';
    let mass = 0;
    let volume = 0;
    
    if (productInfo) {
      name = productInfo.name;
      mass = quantity * productInfo.massPerUnit;
      volume = quantity * productInfo.volumePerUnit;
    }
    
    csv += `${productId},"${name}",${quantity},${mass},${volume}\n`;
  });
  
  // Write CSV to file
  fs.writeFileSync(outputFile, csv);
  console.log(`Inventory exported to ${outputFile}`);
}

// Main function
async function main() {
  try {
    // Step 1: Initialize RpcProvider
    console.log('Initializing Starknet RpcProvider...');
    const rpcUrl = "https://starknet-mainnet.public.blastapi.io/rpc/v0_7";
    const provider = new RpcProvider({ nodeUrl: rpcUrl });
    console.log(`RpcProvider initialized`);
    
    // Step 2: Set up Dispatcher contract address
    const dispatcherAddress = "0x0422d33a3638dcc4c62e72e1d6942cd31eb643ef596ccac2351e0e21f6cd4bf4"; 
    
    // Step 3: Pack the entity ID
    const entityKey = Entity.packEntity({
      label: Entity.IDS.BUILDING,
      id: ENTITY_ID
    });
    console.log(`Entity key: ${entityKey}`);
    
    // Step 4: Get building info
    console.log('\nRetrieving building information...');
    const buildingData = await readComponent(provider, dispatcherAddress, "Building", 1, entityKey);
    
    if (!buildingData || buildingData.length < 4) {
      throw new Error(`No valid building data found for entity ${ENTITY_ID}`);
    }
    
    // Parse building data
    const buildingType = parseInt(buildingData[3], 16);
    const buildingStatus = parseInt(buildingData[2], 16);
    const buildingTypeInfo = Building.getType(buildingType);
    
    // Get building type component data
    const buildingTypeData = await readComponent(
      provider, 
      dispatcherAddress, 
      "BuildingType", 
      1,
      "0x" + buildingType.toString(16)
    );
    
    // Extract building type details if available
    let processType, siteSlot, siteType;
    if (buildingTypeData && buildingTypeData.length >= 5) {
      processType = parseInt(buildingTypeData[2], 16);
      siteSlot = parseInt(buildingTypeData[3], 16);
      siteType = parseInt(buildingTypeData[4], 16);
    }
    
    // Output building information
    console.log('\n=== BUILDING INFORMATION ===');
    console.log(`Building ID: ${ENTITY_ID}`);
    console.log(`Building Type: ${buildingTypeInfo ? buildingTypeInfo.name : 'Unknown'} (Type ID: ${buildingType})`);
    console.log(`Status: ${buildingStatus} (${Building.CONSTRUCTION_STATUS_LABELS[buildingStatus] || 'Unknown Status'})`);
    
    if (processType !== undefined) {
      console.log(`Process Type: ${processType}`);
    }
    
    if (buildingTypeInfo) {
      console.log(`Category: ${Building.CATEGORY_TYPES[buildingTypeInfo.category]?.name || 'Unknown'}`);
      console.log(`Description: ${buildingTypeInfo.description}`);
    }
    
    // Step 5: Get inventory data
    console.log('\nRetrieving inventory data...');
    
    // First check slot 1 (site inventory)
    console.log('Checking slot 1 (expected to be site inventory)...');
    const siteInventoryData = await readComponent(provider, dispatcherAddress, "Inventory", 2, entityKey, 1);
    
    if (siteInventoryData) {
        console.log('Found site inventory data in slot 1');
        
        // Quick check if this looks like the site inventory
        const siteInventoryType = parseInt(siteInventoryData[0], 16);
        if (siteInventoryType === Inventory.IDS.WAREHOUSE_SITE || siteInventoryType === 15) {
            console.log(`Confirmed site inventory in slot 1 (Type: ${siteInventoryType})`);
        }
    }
    
    // Then check slot 2 (should be main warehouse inventory)
    console.log('\nChecking slot 2 (expected to be main warehouse inventory)...');
    const warehouseInventoryData = await readComponent(provider, dispatcherAddress, "Inventory", 2, entityKey, 2);
    
    if (warehouseInventoryData) {
        console.log('Found warehouse inventory data in slot 2');
        
        // Quick check if this looks like the warehouse inventory
        const warehouseInventoryType = parseInt(warehouseInventoryData[0], 16);
        if (warehouseInventoryType === Inventory.IDS.WAREHOUSE_PRIMARY) {
            console.log(`Confirmed warehouse inventory in slot 2 (Type: ${warehouseInventoryType})`);
        }
        
        // Analyze the warehouse inventory from slot 2
        console.log('\nAnalyzing warehouse inventory from slot 2...');
        const inventory = parseInventory(warehouseInventoryData);
        
        // Output inventory information
        const inventoryTypeInfo = Inventory.TYPES[inventory.inventoryType];
        
        console.log('\n=== WAREHOUSE INVENTORY DETAILS ===');
        console.log(`Inventory Type: ${inventoryTypeInfo ? inventoryTypeInfo.name : 'Unknown'} (Type ID: ${inventory.inventoryType})`);
        console.log(`Status: ${inventory.status}`);
        console.log(`Mass: ${inventory.mass.toLocaleString()}g`);
        console.log(`Volume: ${inventory.volume.toLocaleString()}mL`);
        console.log(`Reserved Mass: ${inventory.reservedMass.toLocaleString()}g`);
        console.log(`Reserved Volume: ${inventory.reservedVolume.toLocaleString()}mL`);
        
        if (inventoryTypeInfo) {
            console.log(`\nCapacity Information:`);
            console.log(`Max Mass Capacity: ${inventoryTypeInfo.massConstraint === Infinity ? 'Unlimited' : inventoryTypeInfo.massConstraint.toLocaleString() + 'g'}`);
            console.log(`Max Volume Capacity: ${inventoryTypeInfo.volumeConstraint === Infinity ? 'Unlimited' : inventoryTypeInfo.volumeConstraint.toLocaleString() + 'mL'}`);
            console.log(`Category: ${inventoryTypeInfo.category}`);
            console.log(`Modifiable: ${inventoryTypeInfo.modifiable}`);
        }
        
        // Products summary
        console.log(`\nProducts: ${inventory.products.length}`);
        
        // Export inventory to CSV
        exportInventoryToCSV(inventory, OUTPUT_FILE);
        
        return;
    }
    
    // If we don't find the warehouse inventory in slot 2,
    // fall back to using whatever inventory we found first
    let inventoryData = siteInventoryData;
    let warehouseInventorySlot = 1;
    
    // If we don't have site inventory either, try more slots
    if (!inventoryData) {
        for (let slot = 3; slot <= 10; slot++) {
            console.log(`Trying inventory slot ${slot}...`);
            const slotInventoryData = await readComponent(provider, dispatcherAddress, "Inventory", 2, entityKey, slot);
            
            if (slotInventoryData) {
                console.log(`Found inventory data in slot ${slot}`);
                inventoryData = slotInventoryData;
                warehouseInventorySlot = slot;
                break;
            }
        }
    }
    
    if (!inventoryData) {
        throw new Error(`No inventory found for building ${ENTITY_ID} in any slot`);
    }
    
    console.log(`\nAnalyzing inventory from slot ${warehouseInventorySlot}...`);
    
    // Output inventory information
    const inventory = parseInventory(inventoryData);
    
    // Try to get inventory type details from SDK
    const inventoryTypeInfo = Inventory.TYPES[inventory.inventoryType];
    
    console.log('\n=== INVENTORY DETAILS ===');
    if (inventory.isSiteInventory) {
      console.log('THIS IS A BUILDING SITE INVENTORY (not the main warehouse storage)');
    }
    
    console.log(`Inventory Type: ${inventoryTypeInfo ? inventoryTypeInfo.name : 'Unknown'} (Type ID: ${inventory.inventoryType})`);
    console.log(`Status: ${inventory.status}`);
    console.log(`Mass: ${inventory.mass.toLocaleString()}g`);
    console.log(`Volume: ${inventory.volume.toLocaleString()}mL`);
    console.log(`Reserved Mass: ${inventory.reservedMass.toLocaleString()}g`);
    console.log(`Reserved Volume: ${inventory.reservedVolume.toLocaleString()}mL`);
    
    // Show raw data for debugging
    console.log('\n=== RAW DATA SAMPLE ===');
    console.log(inventory.rawData.map((val, idx) => `[${idx}]: ${val}`).join('\n'));
    
    if (inventoryTypeInfo) {
      console.log(`\nExpected Type Properties:`);
      console.log(`Max Mass Capacity: ${inventoryTypeInfo.massConstraint === Infinity ? 'Unlimited' : inventoryTypeInfo.massConstraint.toLocaleString() + 'g'}`);
      console.log(`Max Volume Capacity: ${inventoryTypeInfo.volumeConstraint === Infinity ? 'Unlimited' : inventoryTypeInfo.volumeConstraint.toLocaleString() + 'mL'}`);
      console.log(`Category: ${inventoryTypeInfo.category}`);
      console.log(`Modifiable: ${inventoryTypeInfo.modifiable}`);
    }
    
    // Products summary
    console.log(`\nProducts: ${inventory.products.length}`);
    
    // If this is a site inventory and not the main warehouse storage,
    // inform the user and suggest trying a different slot
    if (inventory.isSiteInventory && inventory.inventoryType !== 10) {
      console.log('\n⚠️ NOTE: This appears to be the building site inventory containing construction materials.');
      console.log('The actual warehouse storage inventory should be in a different slot.');
      console.log('Try running the script with a different building ID or examining other inventory slots.');
    }
    
    console.log(`Products: ${inventory.products.length}`);
    
    // Export inventory to CSV
    exportInventoryToCSV(inventory, OUTPUT_FILE);
    
    console.log('\n✅ Warehouse inventory query completed successfully.');
    
  } catch (error) {
    console.error('\n❌ ERROR:');
    console.error(error.message);
    
    if (error.stack) {
      console.error('\nFull error details:');
      console.error(error.stack);
    }
    
    process.exit(1);
  }
}

// Run the main function
main();